---
name: browser-testing
description: When you need UI in a real browser — reproduce a visual bug, scrape a page, or verify a UI change you just made — drive it with the Playwright CLI in Firefox instead of a browser MCP server, and iterate with screenshots rather than editing UI blind.
---

# Browser automation with the Playwright CLI

Drive a real browser with the **Playwright CLI** (`@playwright/cli`, a
devDependency), not a browser MCP server. It's the token-efficient path for
coding agents: concise commands instead of large tool schemas and
accessibility trees loaded into context. Discover the full command set from
its own help:

```
pnpm exec playwright-cli --help
```

Typical session:

```
pnpm exec playwright-cli open <url> --browser firefox
pnpm exec playwright-cli snapshot          # a11y snapshot with element refs
pnpm exec playwright-cli click <ref>
pnpm exec playwright-cli close
```

## Verify UI changes in the browser — don't edit blind

After any visual change (CSS, layout, spacing, colors, component markup),
render the affected page and `screenshot` it before declaring done — that's
how you catch overflow, contrast, broken wrapping, and dark-mode glitches a
unit test won't. Point it at your `pnpm dev:isolated` server (see the
`repo-toolchain` skill) and check the states that matter — narrow/wide
viewport (`resize`), light/dark, hover/focus/error — not just the happy path.

## Notes

- This repo standardizes on **Firefox** (so do e2e tests); pass
  `--browser firefox`. If the browser isn't installed yet, run
  `pnpm run test:e2e:install` — the repo's Firefox installer
  (`playwright install --with-deps firefox`).
- The CLI writes scratch artifacts (snapshots, console logs) under
  `.playwright-cli/`, which is gitignored.
