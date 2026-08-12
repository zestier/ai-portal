-- 023_shell_command_path_scopes.sql
--
-- Canonicalize structured shell grants from the legacy
--   { argv0, subcommands?, preSubcommandOptions?, options? }
-- shape to the command-path shape:
--   { command: [{ token, options? }, ...] }
--
-- Legacy `subcommands` were alternatives, so rows with multiple entries are
-- split into one grant per command path. The matcher already ORs grants, which
-- makes separate rows the canonical representation for alternatives.

CREATE TEMP TABLE _legacy_shell_command_scope_rows AS
SELECT rowid AS grant_rowid
FROM permission_grants
WHERE scope_json IS NOT NULL
  AND json_valid(scope_json)
  AND json_extract(scope_json, '$.kind') = 'shell'
  AND json_type(scope_json, '$.rule.command') IS NULL
  AND json_type(scope_json, '$.rule.argv0') = 'text'
  AND json_extract(scope_json, '$.rule.argv0') <> ''
  AND instr(json_extract(scope_json, '$.rule.argv0'), '/') = 0
  AND substr(json_extract(scope_json, '$.rule.argv0'), 1, 1) <> '.'
  AND (
    json_type(scope_json, '$.rule.preSubcommandOptions') IS NULL
    OR json_type(scope_json, '$.rule.preSubcommandOptions') = 'object'
  )
  AND (
    json_type(scope_json, '$.rule.options') IS NULL
    OR json_type(scope_json, '$.rule.options') = 'object'
  )
  AND (
    json_type(scope_json, '$.rule.positionals') IS NULL
    OR json_type(scope_json, '$.rule.positionals') = 'object'
  )
  AND (
    json_type(scope_json, '$.rule.pipeline') IS NULL
    OR json_extract(scope_json, '$.rule.pipeline') IN ('must', 'forbid')
  )
  AND (
    json_type(scope_json, '$.rule.subcommands') IS NULL
    OR json_type(scope_json, '$.rule.subcommands') = 'array'
  );

INSERT INTO permission_grants (
  user_id,
  conversation_id,
  tool,
  permission_kind,
  scope_pattern,
  scope_json,
  decision,
  expires_at,
  granted_at,
  deny_reason,
  args_hash,
  source
)
SELECT
  pg.user_id,
  pg.conversation_id,
  pg.tool,
  pg.permission_kind,
  pg.scope_pattern,
  json_object(
    'kind', 'shell',
    'rule', json_patch(
      json_patch(
        json_object(
          'command',
          json_array(
            json_patch(
              json_object('token', json_extract(pg.scope_json, '$.rule.argv0')),
              CASE
                WHEN json_type(pg.scope_json, '$.rule.preSubcommandOptions') = 'object'
                  THEN json_object('options', json(json_extract(pg.scope_json, '$.rule.preSubcommandOptions')))
                ELSE json('{}')
              END
            ),
            json_patch(
              json_object('token', je.value),
              CASE
                WHEN json_type(pg.scope_json, '$.rule.options') = 'object'
                  THEN json_object('options', json(json_extract(pg.scope_json, '$.rule.options')))
                ELSE json('{}')
              END
            )
          )
        ),
        CASE
          WHEN json_type(pg.scope_json, '$.rule.positionals') = 'object'
            THEN json_object('positionals', json(json_extract(pg.scope_json, '$.rule.positionals')))
          ELSE json('{}')
        END
      ),
      CASE
        WHEN json_extract(pg.scope_json, '$.rule.pipeline') IN ('must', 'forbid')
          THEN json_object('pipeline', json_extract(pg.scope_json, '$.rule.pipeline'))
        ELSE json('{}')
      END
    )
  ),
  pg.decision,
  pg.expires_at,
  pg.granted_at,
  pg.deny_reason,
  pg.args_hash,
  pg.source
FROM permission_grants AS pg
JOIN _legacy_shell_command_scope_rows AS legacy ON legacy.grant_rowid = pg.rowid
JOIN json_each(pg.scope_json, '$.rule.subcommands') AS je
WHERE json_type(pg.scope_json, '$.rule.subcommands') = 'array'
  AND json_array_length(pg.scope_json, '$.rule.subcommands') > 0
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(pg.scope_json, '$.rule.subcommands') AS bad
    WHERE bad.type <> 'text' OR bad.value = ''
  );

DELETE FROM permission_grants
WHERE rowid IN (
  SELECT pg.rowid
  FROM permission_grants AS pg
  JOIN _legacy_shell_command_scope_rows AS legacy ON legacy.grant_rowid = pg.rowid
  WHERE json_type(pg.scope_json, '$.rule.subcommands') = 'array'
    AND json_array_length(pg.scope_json, '$.rule.subcommands') > 0
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(pg.scope_json, '$.rule.subcommands') AS bad
      WHERE bad.type <> 'text' OR bad.value = ''
    )
);

UPDATE permission_grants
SET scope_json = json_object(
  'kind', 'shell',
  'rule', json_patch(
    json_patch(
      json_object(
        'command',
        json_array(
          json_patch(
            json_object('token', json_extract(scope_json, '$.rule.argv0')),
            CASE
              WHEN json_type(scope_json, '$.rule.preSubcommandOptions') = 'object'
                   OR json_type(scope_json, '$.rule.options') = 'object'
                THEN json_object(
                  'options',
                  json_patch(
                    CASE
                      WHEN json_type(scope_json, '$.rule.preSubcommandOptions.allow') = 'array'
                           OR json_type(scope_json, '$.rule.options.allow') = 'array'
                        THEN json_object(
                          'allow',
                          json((
                            SELECT json_group_array(json(value))
                            FROM (
                              SELECT value
                              FROM json_each(scope_json, '$.rule.preSubcommandOptions.allow')
                              UNION ALL
                              SELECT value
                              FROM json_each(scope_json, '$.rule.options.allow')
                            )
                          ))
                        )
                      ELSE json('{}')
                    END,
                    CASE
                      WHEN json_type(scope_json, '$.rule.preSubcommandOptions.deny') = 'array'
                           OR json_type(scope_json, '$.rule.options.deny') = 'array'
                        THEN json_object(
                          'deny',
                          json((
                            SELECT json_group_array(value)
                            FROM (
                              SELECT value
                              FROM json_each(scope_json, '$.rule.preSubcommandOptions.deny')
                              UNION ALL
                              SELECT value
                              FROM json_each(scope_json, '$.rule.options.deny')
                            )
                          ))
                        )
                      ELSE json('{}')
                    END
                  )
                )
              ELSE json('{}')
            END
          )
        )
      ),
      CASE
        WHEN json_type(scope_json, '$.rule.positionals') = 'object'
          THEN json_object('positionals', json(json_extract(scope_json, '$.rule.positionals')))
        ELSE json('{}')
      END
    ),
    CASE
      WHEN json_extract(scope_json, '$.rule.pipeline') IN ('must', 'forbid')
        THEN json_object('pipeline', json_extract(scope_json, '$.rule.pipeline'))
      ELSE json('{}')
    END
  )
)
WHERE rowid IN (
  SELECT pg.rowid
  FROM permission_grants AS pg
  JOIN _legacy_shell_command_scope_rows AS legacy ON legacy.grant_rowid = pg.rowid
  WHERE json_type(pg.scope_json, '$.rule.subcommands') IS NULL
    OR json_array_length(pg.scope_json, '$.rule.subcommands') = 0
);

DROP TABLE _legacy_shell_command_scope_rows;
