import { test, expect } from "./helpers/fixtures";
import {
  createConversation,
  uniqueTitle,
  waitForAssistantMessage,
} from "./helpers/conversations";

// In-app search (FTS) + `?message=` permalink deep-links — the replacements
// for whole-transcript Ctrl+F in the windowed transcript. Both must land on
// the right message even when it lives outside the initially loaded window.
test("in-conversation search finds a message and jumps to it", async ({
  page,
  request,
}) => {
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warn")
      console.log("CONSOLE:", m.text());
  });
  const needle = `needle-${uniqueTitle("find").replace(/\s/g, "-").toLowerCase()}`;
  const id = await createConversation(request, uniqueTitle("E2E search"));
  await page.goto(`/conversations/${id}`);

  const composer = page.getByPlaceholder(/Message…/);
  await composer.fill(`search for ${needle} inside`);
  await composer.press("Enter");
  await waitForAssistantMessage(request, id, /Stubbed reply/);
  await page.reload();

  // Open the search box and run a query matching the user message.
  await page.getByRole("button", { name: "Search this conversation" }).click();
  const searchInput = page.getByLabel("Search this conversation");
  await searchInput.fill(needle);
  // Wait for the search round-trip so we can distinguish a client bug (no
  // request) from a server/rendering bug (request answered, no results shown).
  const searchResponse = page.waitForResponse(
    (r) =>
      r.url().includes("/api/conversations/") && r.url().includes("/search?q="),
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const resp = await searchResponse;
  expect(resp.status()).toBe(200);

  // A result row appears; clicking it jumps to (hydrates) the message.
  const result = page.locator(".search-result").filter({ hasText: needle });
  await expect(result.first()).toBeVisible();
  await result.first().click();
  await expect(
    page.getByText(`search for ${needle} inside`).first(),
  ).toBeVisible();
});

test("?message=<id> permalink scrolls to and highlights the target", async ({
  page,
  request,
}) => {
  const id = await createConversation(request, uniqueTitle("E2E permalink"));
  await page.goto(`/conversations/${id}`);

  const composer = page.getByPlaceholder(/Message…/);
  await composer.fill("permalink target message");
  await composer.press("Enter");
  await waitForAssistantMessage(request, id, /Stubbed reply/);

  // Find the persisted user-message id, then reload with ?message=<id>.
  const conv = await (await request.get(`/api/conversations/${id}`)).json();
  const userMessage = (
    conv.transcript.tail as Array<{ id: number; content: string }>
  ).find((m) => m.content === "permalink target message");
  expect(userMessage).toBeTruthy();
  await page.goto(`/conversations/${id}?message=${userMessage!.id}`);

  await expect(
    page.getByText("permalink target message").first(),
  ).toBeVisible();
  // The jump lands the message in view; the highlight class is applied.
  await expect(page.locator(".highlighted").first()).toBeVisible();
});
