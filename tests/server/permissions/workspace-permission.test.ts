import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPathInWorkspace } from "../../../src/lib/server/permissions/workspace";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isPathInWorkspace", () => {
  let tmpRoot: string; // realpath'd root used in assertions
  let root: string; // what we pass in (may differ if tmpdir is itself a symlink — common on macOS)
  let outside: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "portal-ws-perm-"));
    tmpRoot = realpathSync(base);
    root = tmpRoot;
    mkdirSync(join(tmpRoot, "src"));
    writeFileSync(join(tmpRoot, "src", "a.ts"), "x");
    // sibling that shares a prefix with the root, to guard against
    // `/work/repo-evil` vs `/work/repo` false positives.
    outside = `${tmpRoot}-evil`;
    mkdirSync(outside);
    writeFileSync(join(outside, "x"), "x");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts paths equal to the root", () => {
    expect(isPathInWorkspace(root, root)).toBe(true);
    expect(isPathInWorkspace(root + "/", root)).toBe(true);
    expect(isPathInWorkspace(".", root)).toBe(true);
  });

  it("accepts absolute paths inside the root", () => {
    expect(isPathInWorkspace(join(root, "src", "a.ts"), root)).toBe(true);
  });

  it("accepts relative paths that resolve inside the root", () => {
    expect(isPathInWorkspace("src/a.ts", root)).toBe(true);
    expect(isPathInWorkspace("./src/a.ts", root)).toBe(true);
    expect(isPathInWorkspace("src/../src/a.ts", root)).toBe(true);
  });

  it("accepts not-yet-existing paths whose parent is inside the root", () => {
    expect(isPathInWorkspace(join(root, "src", "new-file.ts"), root)).toBe(
      true,
    );
    expect(isPathInWorkspace("src/deep/does/not/exist.ts", root)).toBe(true);
  });

  it("rejects absolute paths outside the root", () => {
    expect(isPathInWorkspace("/etc/passwd", root)).toBe(false);
    expect(isPathInWorkspace(join(outside, "x"), root)).toBe(false);
  });

  it("rejects relative paths that escape via ..", () => {
    expect(isPathInWorkspace("../other/x", root)).toBe(false);
    expect(isPathInWorkspace("src/../../etc/passwd", root)).toBe(false);
    expect(isPathInWorkspace("..", root)).toBe(false);
  });

  it("rejects sibling paths that share a prefix with the root", () => {
    expect(isPathInWorkspace(outside, root)).toBe(false);
    expect(isPathInWorkspace(join(outside, "x"), root)).toBe(false);
  });

  it("rejects symlinks that point outside the root (existing target)", () => {
    const escape = join(root, "escape");
    symlinkSync("/etc", escape);
    expect(isPathInWorkspace(escape, root)).toBe(false);
    // And a path under the escape link:
    // `/etc/passwd` exists on every CI runner we care about; if it
    // doesn't, the parent-fallback still resolves /etc and gives the
    // same answer.
    expect(isPathInWorkspace(join(escape, "passwd"), root)).toBe(false);
  });

  it("rejects not-yet-existing paths under a symlink that escapes the root", () => {
    const escape = join(root, "escape-dir");
    symlinkSync(outside, escape);
    // The new file doesn't exist; parent fallback should resolve
    // `escape-dir` → outside, putting the would-be file outside root.
    expect(isPathInWorkspace(join(escape, "new.ts"), root)).toBe(false);
  });

  it("accepts symlinks that point inside the root", () => {
    const innerLink = join(root, "src", "link.ts");
    symlinkSync(join(root, "src", "a.ts"), innerLink);
    expect(isPathInWorkspace(innerLink, root)).toBe(true);
  });

  it("handles a workspace root that is itself a symlink", () => {
    const linkedRoot = `${tmpRoot}-link`;
    symlinkSync(tmpRoot, linkedRoot);
    try {
      expect(
        isPathInWorkspace(join(linkedRoot, "src", "a.ts"), linkedRoot),
      ).toBe(true);
      expect(
        isPathInWorkspace(join(linkedRoot, "src", "new.ts"), linkedRoot),
      ).toBe(true);
      expect(isPathInWorkspace("/etc/passwd", linkedRoot)).toBe(false);
    } finally {
      unlinkSync(linkedRoot);
    }
  });

  it("returns false on empty inputs and NUL bytes", () => {
    expect(isPathInWorkspace("", root)).toBe(false);
    expect(isPathInWorkspace(join(root, "x"), "")).toBe(false);
    expect(isPathInWorkspace("src/a\0.ts", root)).toBe(false);
    expect(isPathInWorkspace(join(root, "x"), root + "\0")).toBe(false);
  });

  it("returns false when the workspace root does not exist", () => {
    expect(isPathInWorkspace("x", "/nonexistent/path/here")).toBe(false);
  });
});
