-- 022_permission_grant_source.sql
--
-- Track where a permission grant came from so Settings can distinguish
-- curated defaults, prompt-created grants, manually authored grants, and older
-- rows. Existing rows are marked `legacy`, then identifiable default seed rows
-- are marked `seed`. The migration intentionally does not rewrite decisions:
-- old default deny nudges remain deny until the user explicitly restores
-- defaults from Settings.

ALTER TABLE permission_grants ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';

UPDATE permission_grants
SET source = 'seed'
WHERE conversation_id IS NULL
  AND args_hash IS NULL
  AND scope_json IS NOT NULL
  AND json_valid(scope_json)
  AND (
    (
      decision = 'allow'
      AND (
        (
          tool IN ('git_status', 'git_diff', 'git_log', 'git_show_commit', 'git_show_file',
                   'ticket_add', 'ticket_list', 'ticket_get', 'ticket_update',
                   'permission_capabilities')
          AND permission_kind = 'custom-tool'
          AND json_extract(scope_json, '$.kind') = 'any'
        )
        OR (
          tool IN ('read', 'write', 'edit')
          AND permission_kind = tool
          AND json_extract(scope_json, '$.kind') = 'fs'
          AND json_extract(scope_json, '$.perms[0]') = tool
          AND json_extract(scope_json, '$.rule.kind') = 'path'
          AND json_extract(scope_json, '$.rule.root') = 'session-workspace'
          AND json_extract(scope_json, '$.rule.behavior') = 'any'
        )
        OR (
          tool = 'shell'
          AND permission_kind = 'shell'
          AND json_extract(scope_json, '$.kind') = 'shell'
          AND (
            (
              json_extract(scope_json, '$.rule.argv0') IN
                ('echo', 'printf', 'pwd', 'date', 'whoami', 'hostname', 'uname',
                 'true', 'false', 'basename', 'dirname', 'yes')
              AND json_extract(scope_json, '$.rule.positionals.kind') = 'any'
            )
            OR (
              json_extract(scope_json, '$.rule.argv0') IN
                ('cat', 'head', 'tail', 'wc', 'file', 'stat', 'ls', 'sort', 'uniq',
                 'cut', 'tr', 'realpath', 'readlink', 'md5sum', 'sha1sum', 'sha256sum')
              AND json_extract(scope_json, '$.rule.positionals.kind') IN
                ('workspace-paths', 'session-workspace-paths')
            )
            OR (
              json_extract(scope_json, '$.rule.argv0') = 'grep'
              AND json_extract(scope_json, '$.rule.positionals.kind') = 'any'
            )
            OR (
              json_extract(scope_json, '$.rule.argv0') = 'rg'
              AND json_extract(scope_json, '$.rule.options.deny[0]') = '--pre'
              AND json_extract(scope_json, '$.rule.options.deny[1]') = '--pre-glob'
              AND json_extract(scope_json, '$.rule.options.deny[2]') = '--hostname-bin'
              AND json_extract(scope_json, '$.rule.options.deny[3]') = '--no-config'
            )
            OR (
              json_extract(scope_json, '$.rule.argv0') = 'find'
              AND json_extract(scope_json, '$.rule.options.deny[0]') = '-exec'
              AND json_extract(scope_json, '$.rule.options.deny[1]') = '-execdir'
              AND json_extract(scope_json, '$.rule.options.deny[2]') = '-ok'
              AND json_extract(scope_json, '$.rule.options.deny[3]') = '-okdir'
              AND json_extract(scope_json, '$.rule.options.deny[4]') = '-delete'
              AND json_extract(scope_json, '$.rule.options.deny[5]') = '-fprint'
              AND json_extract(scope_json, '$.rule.options.deny[6]') = '-fprintf'
            )
          )
        )
      )
    )
    OR (
      decision IN ('deny', 'prompt')
      AND tool = 'shell'
      AND permission_kind = 'shell'
      AND json_extract(scope_json, '$.kind') = 'shell'
      AND (
        json_extract(scope_json, '$.rule.argv0') = 'git'
        OR (
          json_extract(scope_json, '$.rule.pipeline') = 'forbid'
          AND json_extract(scope_json, '$.rule.argv0') IN ('cat', 'head', 'tail', 'grep', 'rg', 'find', 'ls')
        )
      )
    )
  );
