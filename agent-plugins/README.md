# agent-plugins

Every immediate subfolder here is loaded as a plugin into the Claude Agent SDK
by the portal's claude-agent provider. A subfolder counts as a plugin only when
it carries the SDK's own plugin manifest (`.claude-plugin/plugin.json` with a
`name`); other subfolders are ignored.

Because plugins are folders, both sourcing paths work with no extra wiring:

- **Repo-committed** plugins live here directly.
- **Third-party** plugins drop in via git submodule:

  ```bash
  git submodule add <plugin-url> agent-plugins/<name>
  ```

See `docs/claude-agent-backends.md` for how the loader works.
