import { test, expect } from "./helpers/fixtures";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uniqueTitle, waitForAssistantMessage } from "./helpers/conversations";

// The server runs with cwd=DATA_DIR (playwright.config.ts), so PROJECT_ROOT —
// and therefore the workdir allowlist — is this directory. A repository created
// *inside* it is a legal `sourcePath` for a worktree conversation, which is what
// lets this spec exercise the real end-to-end flow instead of stubbing it.
const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".tmp-data",
);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sourceRepository(): string {
  const repo = mkdtempSync(join(workspaceRoot, "wt-src-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "E2E"]);
  git(repo, ["config", "user.email", "e2e@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

test("a worktree session reports, badges, and merges back its unmerged work", async ({
  page,
  request,
}) => {
  const repo = sourceRepository();
  const title = uniqueTitle("E2E worktree");
  const created = await request.post("/api/conversations", {
    data: { title, workspace: { kind: "worktree", sourcePath: repo } },
  });
  expect(created.ok()).toBeTruthy();
  const { conversation } = await created.json();
  expect(conversation.workspaceKind).toBe("managed-worktree");

  // Commit inside the isolated checkout: the source tree must not see it yet.
  writeFileSync(join(conversation.workdir, "feature.txt"), "work\n");
  git(conversation.workdir, ["add", "feature.txt"]);
  git(conversation.workdir, ["commit", "-q", "-m", "add feature"]);
  expect(existsSync(join(repo, "feature.txt"))).toBe(false);

  const status = await (
    await request.get(`/api/conversations/${conversation.id}/worktree`)
  ).json();
  expect(status.worktree).toMatchObject({
    isLinkedWorktree: true,
    ahead: 1,
    unmerged: true,
    upstreamBranch: "main",
  });

  const bulk = await (await request.get("/api/worktrees/status")).json();
  expect(bulk.worktrees).toContainEqual(
    expect.objectContaining({
      conversationId: conversation.id,
      unmerged: true,
    }),
  );

  await page.goto(`/conversations/${conversation.id}`);
  await expect(page.getByTestId("header-unmerged")).toBeVisible();

  // The sidebar badge is what flags the session from outside it.
  await expect(
    page
      .locator(`.conv:has(a[href="/conversations/${conversation.id}"])`)
      .getByTestId("unmerged-badge"),
  ).toBeVisible();

  await page.locator("button.chat-header-row").click();
  const merge = page.getByRole("button", { name: "Merge into main" });
  await expect(merge).toBeEnabled();
  await merge.click();

  // Assert durable post-merge state rather than the success flash, which the
  // header clears on a timer shorter than the expect timeout.
  await expect(page.getByTestId("header-unmerged")).toHaveCount(0);
  await expect(merge).toBeDisabled();
  await expect(page.getByText("Fully merged")).toBeVisible();
  expect(existsSync(join(repo, "feature.txt"))).toBe(true);

  // The sidebar badge must clear off the back of the merge itself, not the slow
  // background poll — this expect times out well before the next poll tick.
  await expect(
    page
      .locator(`.conv:has(a[href="/conversations/${conversation.id}"])`)
      .getByTestId("unmerged-badge"),
  ).toHaveCount(0);
});

test("unmerged indicators appear at turn end without a reload", async ({
  page,
  request,
}) => {
  const repo = sourceRepository();
  const title = uniqueTitle("E2E worktree refresh");
  const created = await request.post("/api/conversations", {
    data: { title, workspace: { kind: "worktree", sourcePath: repo } },
  });
  expect(created.ok()).toBeTruthy();
  const { conversation } = await created.json();

  // Wait out the sidebar's mount-time poll before touching git, so a badge
  // later on can only have come from a refresh, not from a lucky race with the
  // very first read.
  const firstPoll = page.waitForResponse((r) =>
    r.url().includes("/api/worktrees/status"),
  );
  await page.goto(`/conversations/${conversation.id}`);
  await firstPoll;

  const composer = page.getByPlaceholder(/Message…/);
  // Spend the auto-title turn first: it triggers `invalidateAll()`, which
  // refreshes the indicators as a side effect and would mask the bug.
  await composer.click();
  await composer.fill("first message");
  await composer.press("Enter");
  await waitForAssistantMessage(
    request,
    conversation.id,
    "Stubbed reply to: first message",
  );
  await expect(page.getByTestId("header-unmerged")).toHaveCount(0);

  // Stand in for the agent committing mid-turn: the checkout gains work while
  // the page is already open, which is exactly when the indicators used to go
  // stale until a manual reload.
  writeFileSync(join(conversation.workdir, "feature.txt"), "work\n");
  git(conversation.workdir, ["add", "feature.txt"]);
  git(conversation.workdir, ["commit", "-q", "-m", "add feature"]);

  await composer.fill("commit something");
  await composer.press("Enter");
  await waitForAssistantMessage(
    request,
    conversation.id,
    "Stubbed reply to: commit something",
  );

  // Both indicators must catch up off the turn-end signal — far sooner than the
  // sidebar's background poll would deliver.
  await expect(page.getByTestId("header-unmerged")).toBeVisible();
  await expect(
    page
      .locator(`.conv:has(a[href="/conversations/${conversation.id}"])`)
      .getByTestId("unmerged-badge"),
  ).toBeVisible();
});
