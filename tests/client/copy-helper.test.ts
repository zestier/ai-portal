import { describe, it, expect, vi, afterEach } from "vitest";
import {
  trimOneTrailingNewline,
  writeClipboard,
} from "../../src/lib/client/copy-helper";

describe("trimOneTrailingNewline", () => {
  it("removes a single trailing \\n", () => {
    expect(trimOneTrailingNewline("hello\n")).toBe("hello");
  });

  it("removes a trailing \\r\\n as one newline", () => {
    expect(trimOneTrailingNewline("hello\r\n")).toBe("hello");
  });

  it("removes at most ONE trailing newline", () => {
    expect(trimOneTrailingNewline("hello\n\n")).toBe("hello\n");
  });

  it("preserves interior and leading newlines", () => {
    expect(trimOneTrailingNewline("a\nb\nc")).toBe("a\nb\nc");
    expect(trimOneTrailingNewline("\nfoo\n")).toBe("\nfoo");
  });

  it("leaves text without a trailing newline unchanged", () => {
    expect(trimOneTrailingNewline("hello")).toBe("hello");
    expect(trimOneTrailingNewline("")).toBe("");
  });

  it("does not strip a trailing lone \\r", () => {
    expect(trimOneTrailingNewline("hello\r")).toBe("hello\r");
  });
});

describe("writeClipboard", () => {
  const original = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: original,
      configurable: true,
    });
  });

  function setNavigator(value: unknown) {
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
    });
  }

  it("returns true and writes when the Clipboard API succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });
    await expect(writeClipboard("payload")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("payload");
  });

  it("returns false when navigator.clipboard is unavailable", async () => {
    setNavigator({});
    await expect(writeClipboard("payload")).resolves.toBe(false);
  });

  it("returns false when writeText throws (e.g. insecure context)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setNavigator({ clipboard: { writeText } });
    await expect(writeClipboard("payload")).resolves.toBe(false);
  });
});
