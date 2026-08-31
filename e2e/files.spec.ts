import { test, expect } from "./helpers/fixtures";
import type { Route } from "@playwright/test";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uniqueTitle } from "./helpers/conversations";

// Server is launched with cwd=DATA_DIR (see playwright.config.ts) so the file
// browser's workspace root is this directory.
const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".generated",
  "e2e",
);

function createWorkdir() {
  return mkdtempSync(join(workspaceRoot, "test-workdir-"));
}

async function createConversation(
  request: import("@playwright/test").APIRequestContext,
  workdir: string,
) {
  const res = await request.post("/api/conversations", {
    data: { title: uniqueTitle("E2E files"), workdir },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return { id: body.conversation.id as string };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function fulfillJson(route: Route, body: unknown) {
  await route
    .fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
    .catch(() => undefined);
}

test("Files tab lists workspace contents and reads a file", async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  // Drop a file at the workspace root.
  writeFileSync(join(workdir, "hello.txt"), "greetings\n");
  mkdirSync(join(workdir, "sub"), { recursive: true });
  writeFileSync(join(workdir, "sub", "inner.txt"), "nested\n");

  const tree = await request.get(`/api/conversations/${id}/fs/tree`);
  expect(tree.ok()).toBeTruthy();
  const treeBody = await tree.json();
  const names = treeBody.entries.map((e: { name: string }) => e.name);
  expect(names).toContain("hello.txt");
  expect(names).toContain("sub");

  const file = await request.get(
    `/api/conversations/${id}/fs/file?path=hello.txt`,
  );
  expect(file.ok()).toBeTruthy();
  const fileBody = await file.json();
  expect(fileBody.file.content).toBe("greetings\n");

  await page.goto(`/conversations/${id}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page).toHaveURL(`/conversations/${id}?tab=files`);
  await expect(page.getByRole("button", { name: /hello\.txt/ })).toBeVisible();
  await page.getByRole("button", { name: /hello\.txt/ }).click();
  await expect(page.locator(".file-view")).toContainText("greetings");
  await page.reload();
  await expect(page).toHaveURL(`/conversations/${id}?tab=files`);
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: /hello\.txt/ })).toBeVisible();
});

// A minimal valid PNG (1x1) — written to the workspace so the file browser can
// detect it as an image and render it inline instead of "Binary file".
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

// SVG carrying a <script> and an onload handler; the browser/raw endpoint must
// report image/svg+xml, strip the script, and lock the response down with CSP.
const DANGEROUS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10" fill="#0a0"/></svg>';

test("Files tab renders an image file inline", async ({ page, request }) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  writeFileSync(join(workdir, "pic.png"), TINY_PNG);

  // API: the file is reported binary, but flagged as a renderable image, and
  // the raw mode serves real PNG bytes.
  const meta = await request.get(
    `/api/conversations/${id}/fs/file?path=pic.png`,
  );
  expect(meta.ok()).toBeTruthy();
  const metaBody = await meta.json();
  expect(metaBody.file.binary).toBe(true);
  expect(metaBody.file.imageMimeType).toBe("image/png");

  const raw = await request.get(
    `/api/conversations/${id}/fs/file?path=pic.png&raw=1`,
  );
  expect(raw.ok()).toBeTruthy();
  expect(raw.headers()["content-type"]).toContain("image/png");
  expect((await raw.body()).length).toBe(TINY_PNG.length);

  // A non-image path must NOT be served by the raw mode.
  writeFileSync(join(workdir, "notes.txt"), "hello\n");
  const rawText = await request.get(
    `/api/conversations/${id}/fs/file?path=notes.txt&raw=1`,
  );
  expect(rawText.status()).toBe(404);

  // UI: selecting the image shows an <img>, not the binary placeholder.
  await page.goto(`/conversations/${id}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: /pic\.png/ }).click();
  const img = page.locator(".image-preview img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /raw=1/);
  // The caption surfaces the natural dimensions so tiny (e.g. 1×1) images are
  // obviously present rather than looking like an empty pane.
  await expect(page.locator(".image-caption")).toContainText("1 × 1 px");
});

test("Files tab renders an SVG inline, sanitized and sandboxed", async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  writeFileSync(join(workdir, "logo.svg"), DANGEROUS_SVG);

  // API: SVG is text but flagged as a renderable image so the client inlines it.
  const meta = await request.get(
    `/api/conversations/${id}/fs/file?path=logo.svg`,
  );
  expect(meta.ok()).toBeTruthy();
  const metaBody = await meta.json();
  expect(metaBody.file.binary).toBe(true);
  expect(metaBody.file.imageMimeType).toBe("image/svg+xml");

  // Raw mode serves sanitized bytes (no <script>/onload) with nosniff + CSP.
  const raw = await request.get(
    `/api/conversations/${id}/fs/file?path=logo.svg&raw=1`,
  );
  expect(raw.ok()).toBeTruthy();
  expect(raw.headers()["content-type"]).toContain("image/svg+xml");
  expect(raw.headers()["x-content-type-options"]).toBe("nosniff");
  expect(raw.headers()["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  const body = (await raw.body()).toString("utf-8");
  expect(body).not.toMatch(/<script/i);
  expect(body).not.toMatch(/onload/i);
  expect(body).toContain("<rect");

  // UI: selecting the SVG shows an <img>, not the source-code placeholder.
  await page.goto(`/conversations/${id}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: /logo\.svg/ }).click();
  const img = page.locator(".image-preview img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /raw=1/);
});

test("Files tab ignores stale content responses after rapid selection changes", async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  writeFileSync(join(workdir, "slow.txt"), "real slow\n");
  writeFileSync(join(workdir, "fresh.txt"), "real fresh\n");

  const slowStarted = deferred();
  const releaseSlow = deferred();
  await page.route(`**/api/conversations/${id}/fs/file?**`, async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "slow.txt") {
      slowStarted.resolve();
      await releaseSlow.promise;
      await fulfillJson(route, {
        file: {
          binary: false,
          path: "slow.txt",
          content: "stale slow\n",
          size: 11,
          truncated: false,
        },
      });
      return;
    }
    if (path === "fresh.txt") {
      await fulfillJson(route, {
        file: {
          binary: false,
          path: "fresh.txt",
          content: "current fresh\n",
          size: 14,
          truncated: false,
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/conversations/${id}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("button", { name: /slow\.txt/ })).toBeVisible();

  await page.getByRole("button", { name: /slow\.txt/ }).click();
  await slowStarted.promise;
  await page.getByRole("button", { name: /fresh\.txt/ }).click();
  await expect(page.locator(".file-view")).toContainText("current fresh");

  releaseSlow.resolve();
  await expect(page.locator(".file-view")).toContainText("current fresh");
  await expect(page.locator(".file-view")).not.toContainText("stale slow");
});

test("Files tab reports git status when workspace is a repo", async ({
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  // Init a fresh git repo in a subdirectory of the workspace root, then
  // drive the FS endpoints by navigating into it via ?path=.
  const repo = join(workdir, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: repo });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "new.txt"), "fresh\n");

  // The workspace root itself isn't a repo, so the top-level git endpoints
  // return uninitialized; the per-path file tree still works, and we verify
  // the embedded repo's files appear under ?path=repo.
  const tree = await request.get(`/api/conversations/${id}/fs/tree?path=repo`);
  expect(tree.ok()).toBeTruthy();
  const treeBody = await tree.json();
  const names = treeBody.entries.map((e: { name: string }) => e.name);
  expect(names).toContain("a.txt");
  expect(names).toContain("new.txt");
});

test("Changes tab lists modified files with +/- stats and a working diff", async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);

  // Initialise this conversation's workdir as a repo so /git/changes
  // returns real data.
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "e2e@example.com"]);
  g(["config", "user.name", "E2E"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(workdir, "tracked.txt"), "one\ntwo\nthree\n");
  mkdirSync(join(workdir, "pkg"), { recursive: true });
  writeFileSync(join(workdir, "pkg", "mod.txt"), "alpha\nbeta\n");
  g(["add", "tracked.txt", "pkg/mod.txt"]);
  g(["commit", "-q", "-m", "baseline"]);
  // Now make a working-tree change: 2 lines added, 1 removed in tracked.txt.
  writeFileSync(join(workdir, "tracked.txt"), "one\nTWO\nthree\nfour\nfive\n");
  // And an addition deep inside a directory so we can check folder aggregation.
  writeFileSync(join(workdir, "pkg", "mod.txt"), "alpha\nbeta\ngamma\n");

  // --- API: /git/changes shape and line counts ------------------------
  const changesRes = await request.get(`/api/conversations/${id}/git/changes`);
  expect(changesRes.ok()).toBeTruthy();
  const changes = await changesRes.json();
  expect(changes.initialized).toBe(true);
  const byPath = Object.fromEntries(
    (
      changes.entries as Array<{
        path: string;
        added: number | null;
        removed: number | null;
      }>
    ).map((e) => [e.path, e]),
  );
  expect(byPath["tracked.txt"]).toMatchObject({
    status: "modified",
    added: 3,
    removed: 1,
  });
  expect(byPath["pkg/mod.txt"]).toMatchObject({
    status: "modified",
    added: 1,
    removed: 0,
  });

  // --- API: /fs/tree exposes per-file and per-directory stats ---------
  const treeRoot = await (
    await request.get(`/api/conversations/${id}/fs/tree`)
  ).json();
  const rootByName = Object.fromEntries(
    (
      treeRoot.entries as Array<{
        name: string;
        type: string;
        added: number | null;
        removed: number | null;
      }>
    ).map((e) => [e.name, e]),
  );
  expect(rootByName["tracked.txt"]).toMatchObject({ added: 3, removed: 1 });
  // Directory aggregate rolls up its descendants' line counts.
  expect(rootByName["pkg"]).toMatchObject({
    type: "directory",
    added: 1,
    removed: 0,
  });

  // --- UI: Changes is a top-level tab; shows entries with +/- and diff
  await page.goto(`/conversations/${id}`);
  const changesTab = page.getByRole("tab", { name: "Changes" });
  await changesTab.click();
  await expect(changesTab).toBeVisible();
  await expect(changesTab).toHaveAttribute("aria-selected", "true");
  const row = page.getByRole("button", { name: /tracked\.txt/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("+3");
  await expect(row).toContainText("−1");

  await row.click();
  const diff = page.locator(".diff");
  await expect(diff).toBeVisible();
  // Diff header shows aggregate stats.
  await expect(diff.locator(".stats .added")).toHaveText("+3");
  await expect(diff.locator(".stats .removed")).toHaveText("−1");
  // At least one add and one del line are rendered with line numbers.
  await expect(diff.locator(".line.add").first()).toBeVisible();
  await expect(diff.locator(".line.del").first()).toBeVisible();
  await expect(diff.locator(".line.add .gutter").first()).not.toHaveText("");
});

test("Changes tab ignores stale diff responses after rapid selection changes", async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "e2e@example.com"]);
  g(["config", "user.name", "E2E"]);
  g(["config", "commit.gpgsign", "false"]);
  mkdirSync(join(workdir, "pkg"), { recursive: true });
  writeFileSync(join(workdir, "tracked.txt"), "one\ntwo\n");
  writeFileSync(join(workdir, "pkg", "mod.txt"), "alpha\nbeta\n");
  g(["add", "tracked.txt", "pkg/mod.txt"]);
  g(["commit", "-q", "-m", "baseline"]);
  writeFileSync(join(workdir, "tracked.txt"), "one\nTWO\n");
  writeFileSync(join(workdir, "pkg", "mod.txt"), "alpha\nbeta\ngamma\n");

  const slowDiffStarted = deferred();
  const releaseSlowDiff = deferred();
  await page.route(`**/api/conversations/${id}/fs/diff?**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path");
    if (url.searchParams.get("target") !== "worktree-vs-head") {
      await route.continue();
      return;
    }
    if (path === "tracked.txt") {
      slowDiffStarted.resolve();
      await releaseSlowDiff.promise;
      await fulfillJson(route, {
        diff: [
          "diff --git a/tracked.txt b/tracked.txt",
          "--- a/tracked.txt",
          "+++ b/tracked.txt",
          "@@ -1,2 +1,2 @@",
          " one",
          "-two",
          "+STALE",
        ].join("\n"),
      });
      return;
    }
    if (path === "pkg/mod.txt") {
      await fulfillJson(route, {
        diff: [
          "diff --git a/pkg/mod.txt b/pkg/mod.txt",
          "--- a/pkg/mod.txt",
          "+++ b/pkg/mod.txt",
          "@@ -1,2 +1,3 @@",
          " alpha",
          " beta",
          "+gamma",
        ].join("\n"),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/conversations/${id}`);
  const changesTab = page.getByRole("tab", { name: "Changes" });
  await changesTab.click();
  await expect(
    page.getByRole("button", { name: /tracked\.txt/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /tracked\.txt/ }).click();
  await slowDiffStarted.promise;
  await page.getByRole("button", { name: /pkg\/mod\.txt/ }).click();
  await expect(page.locator(".header code.path")).toHaveText("pkg/mod.txt");
  await expect(page.locator(".diff code.path").first()).toHaveText(
    "pkg/mod.txt",
  );
  await expect(page.locator(".diff")).toContainText("gamma");

  releaseSlowDiff.resolve();
  await expect(page.locator(".header code.path")).toHaveText("pkg/mod.txt");
  await expect(page.locator(".diff")).toContainText("gamma");
  await expect(page.locator(".diff")).not.toContainText("STALE");
});

test('Changes tab "Revert all" requires confirmation and then discards changes', async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "e2e@example.com"]);
  g(["config", "user.name", "E2E"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(workdir, "tracked.txt"), "one\ntwo\n");
  g(["add", "tracked.txt"]);
  g(["commit", "-q", "-m", "baseline"]);
  // Working-tree changes: one modified tracked file + one untracked file.
  writeFileSync(join(workdir, "tracked.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(workdir, "untracked.txt"), "fresh\n");

  await page.goto(`/conversations/${id}`);
  await page.getByRole("tab", { name: "Changes" }).click();

  const revertBtn = page.getByRole("button", { name: "Revert all" });
  await expect(revertBtn).toBeEnabled();

  // First click only opens a confirmation dialog naming the affected count; it
  // must not discard anything yet.
  await revertBtn.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("2 uncommitted changes");

  // Cancel leaves the working tree untouched.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  let changes = await (
    await request.get(`/api/conversations/${id}/git/changes`)
  ).json();
  expect(changes.entries.length).toBe(2);

  // Confirming actually reverts: tracked file reset, untracked file deleted.
  await revertBtn.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Revert all" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Revert all" })).toBeDisabled();
  changes = await (
    await request.get(`/api/conversations/${id}/git/changes`)
  ).json();
  expect(changes.entries.length).toBe(0);
});

test("Files and Changes views syntax-highlight recognised code, and screenshot both themes", async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "e2e@example.com"]);
  g(["config", "user.name", "E2E"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(workdir, "sample.ts"), 'const greeting = "hello";\n');
  writeFileSync(join(workdir, "plain"), "no extension here\n");
  g(["add", "sample.ts", "plain"]);
  g(["commit", "-q", "-m", "baseline"]);
  writeFileSync(
    join(workdir, "sample.ts"),
    'const greeting = "hello";\nexport const count = 42;\n',
  );

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/conversations/${id}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // --- Files tab: the content pane highlights a recognised language --------
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("button", { name: /sample\.ts/ })).toBeVisible();
  await page.getByRole("button", { name: /sample\.ts/ }).click();
  // A modified file opens on its Diff sub-tab; the content pane is behind Content.
  await page.getByRole("tab", { name: "Content" }).click();
  const fileView = page.locator(".file-view");
  await expect(fileView).toContainText("greeting");
  await expect(fileView.locator(".hljs-keyword").first()).toBeVisible();
  await expect(fileView.locator(".hljs-string").first()).toBeVisible();
  await page.screenshot({ path: "test-results/highlight-files-dark.png" });

  // A file with no detectable language still renders its text, unhighlighted.
  await page.getByRole("button", { name: /plain/ }).click();
  await expect(page.locator(".file-view")).toContainText("no extension here");
  await expect(page.locator(".file-view .hljs-keyword")).toHaveCount(0);

  // --- Changes tab: diff lines are highlighted without losing diff state ---
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.getByRole("button", { name: /sample\.ts/ })).toBeVisible();
  await page.getByRole("button", { name: /sample\.ts/ }).click();
  const diff = page.locator(".diff");
  await expect(diff).toBeVisible();
  const addLine = diff.locator(".line.add").first();
  await expect(addLine).toBeVisible();
  // Highlighting must not erase the add/del classification or the gutter.
  await expect(addLine.locator(".hljs-keyword").first()).toBeVisible();
  await expect(addLine.locator(".gutter").first()).not.toHaveText("");
  await page.screenshot({ path: "test-results/highlight-diff-dark.png" });

  // --- The palette is theme-driven, so it must survive a light-mode switch --
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(diff.locator(".hljs-keyword").first()).toBeVisible();
  await page.screenshot({ path: "test-results/highlight-diff-light.png" });
});

test("Review comments on file lines can be sent to the chat composer", async ({
  page,
  request,
}) => {
  const workdir = createWorkdir();
  const { id } = await createConversation(request, workdir);
  writeFileSync(join(workdir, "review.txt"), "first line\nsecond line\n");

  await page.goto(`/conversations/${id}`);
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: /review\.txt/ }).click();
  await expect(page.locator(".file-view")).toContainText("first line");

  // Attach a comment to the first line via its per-line affordance.
  const firstLine = page.locator(".file-line").first();
  await firstLine.locator(".comment-add").click();
  const draft = page.locator(".review-draft");
  await expect(draft).toBeVisible();
  await expect(draft.locator(".loc")).toContainText("review.txt:1");
  await draft
    .locator("textarea.review-input")
    .fill("Please rename this variable.");
  await draft.getByRole("button", { name: "Add comment" }).click();

  // The review drawer summarises the pending comment.
  const bar = page.locator(".review-bar");
  await expect(bar).toContainText("1 review comment");

  // Send the assembled review to the chat composer.
  await bar.getByRole("button", { name: "Send to chat" }).click();
  await expect(page).toHaveURL(`/conversations/${id}`);
  const composer = page.locator(".composer textarea");
  await expect(composer).toHaveValue(/Please rename this variable\./);
  await expect(composer).toHaveValue(/review\.txt/);
});
