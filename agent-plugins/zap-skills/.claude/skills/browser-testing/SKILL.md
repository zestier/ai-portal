---
name: browser-testing
description: Drive a real browser (manual checks, UI bug reproduction, page scraping) with the Playwright CLI in Firefox instead of a browser MCP server, and iterate visually with screenshots when changing UI.
---

# Browser automation with the Playwright CLI

Need to drive a real browser (manual checks, reproducing a UI bug, scraping a
page)? Use the **Playwright CLI** (`@playwright/cli`, a devDependency) rather
than a browser MCP server — it's the token-efficient path Microsoft recommends
for coding agents (concise commands instead of large tool schemas and
accessibility trees loaded into context). Discover the full command set from its
own help:

```
pnpm exec playwright-cli --help
```

Then drive a session, e.g.:

```
pnpm exec playwright-cli open https://example.com --browser firefox
pnpm exec playwright-cli snapshot          # accessibility snapshot with element refs
pnpm exec playwright-cli click <ref>
pnpm exec playwright-cli close
```

## Iterate visually — don't edit UI blind

When you change anything visual (CSS, layout, spacing, colors, a component's
markup), close the loop with the browser instead of guessing: render the
affected page, `screenshot` it, look at the result, adjust, and re-screenshot
until it's right. The same loop is how you catch regressions a unit test won't —
overflow, contrast, broken wrapping, dark-mode glitches. A typical pass:

```
pnpm exec playwright-cli open http://localhost:5193/<page> --browser firefox
pnpm exec playwright-cli screenshot        # eyeball it, tweak the code, repeat
```

Point it at your `pnpm dev:isolated` server (see the `isolated-dev` skill), and
check the states that matter for the change — narrow/wide viewport (`resize`),
light/dark, and any hover/focus/error states — not just the happy path.

## Notes

- This repo standardizes on **Firefox** (so do e2e tests); pass
  `--browser firefox`. If the browser isn't installed yet,
  `pnpm exec playwright install firefox` (the CLI also has `install-browser`).
- The CLI writes scratch artifacts (snapshots, console logs) under
  `.playwright-cli/`, which is gitignored.
