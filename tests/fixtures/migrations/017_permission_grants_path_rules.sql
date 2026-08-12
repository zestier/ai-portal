-- 017_permission_grants_path_rules.sql
--
-- Replace the original fs rule enum variants with the composable path rule:
--   root + behavior + value
--
-- This avoids growing a matrix of one-off enum values such as
-- `workspace-glob` and `absolute-glob`.

UPDATE permission_grants
SET scope_json = CASE
  WHEN json_type(scope_json, '$.perms') IS NULL THEN
    json_object(
      'kind', 'fs',
      'rule', json_object('kind', 'path', 'root', 'absolute', 'behavior', 'exact', 'value', json_extract(scope_json, '$.rule.path'))
    )
  ELSE
    json_object(
      'kind', 'fs',
      'perms', json(json_extract(scope_json, '$.perms')),
      'rule', json_object('kind', 'path', 'root', 'absolute', 'behavior', 'exact', 'value', json_extract(scope_json, '$.rule.path'))
    )
  END
WHERE scope_json IS NOT NULL
  AND json_valid(scope_json)
  AND json_extract(scope_json, '$.kind') = 'fs'
  AND json_extract(scope_json, '$.rule.kind') = 'exact'
  AND json_type(scope_json, '$.rule.path') = 'text'
  AND length(json_extract(scope_json, '$.rule.path')) > 0;

UPDATE permission_grants
SET scope_json = CASE
  WHEN json_type(scope_json, '$.perms') IS NULL THEN
    json_object(
      'kind', 'fs',
      'rule', json_object('kind', 'path', 'root', 'workspace', 'behavior', 'any')
    )
  ELSE
    json_object(
      'kind', 'fs',
      'perms', json(json_extract(scope_json, '$.perms')),
      'rule', json_object('kind', 'path', 'root', 'workspace', 'behavior', 'any')
    )
  END
WHERE scope_json IS NOT NULL
  AND json_valid(scope_json)
  AND json_extract(scope_json, '$.kind') = 'fs'
  AND json_extract(scope_json, '$.rule.kind') = 'workspace';

UPDATE permission_grants
SET scope_json = CASE
  WHEN json_type(scope_json, '$.perms') IS NULL THEN
    json_object(
      'kind', 'fs',
      'rule', json_object('kind', 'path', 'root', 'session-workspace', 'behavior', 'any')
    )
  ELSE
    json_object(
      'kind', 'fs',
      'perms', json(json_extract(scope_json, '$.perms')),
      'rule', json_object('kind', 'path', 'root', 'session-workspace', 'behavior', 'any')
    )
  END
WHERE scope_json IS NOT NULL
  AND json_valid(scope_json)
  AND json_extract(scope_json, '$.kind') = 'fs'
  AND json_extract(scope_json, '$.rule.kind') = 'session-workspace';

UPDATE permission_grants
SET scope_json = CASE
  WHEN json_type(scope_json, '$.perms') IS NULL THEN
    json_object(
      'kind', 'fs',
      'rule', json_object('kind', 'path', 'root', 'workspace', 'behavior', 'glob', 'value', json_extract(scope_json, '$.rule.glob'))
    )
  ELSE
    json_object(
      'kind', 'fs',
      'perms', json(json_extract(scope_json, '$.perms')),
      'rule', json_object('kind', 'path', 'root', 'workspace', 'behavior', 'glob', 'value', json_extract(scope_json, '$.rule.glob'))
    )
  END
WHERE scope_json IS NOT NULL
  AND json_valid(scope_json)
  AND json_extract(scope_json, '$.kind') = 'fs'
  AND json_extract(scope_json, '$.rule.kind') = 'workspace-glob'
  AND json_type(scope_json, '$.rule.glob') = 'text'
  AND length(json_extract(scope_json, '$.rule.glob')) > 0;

UPDATE permission_grants
SET scope_json = CASE
  WHEN json_type(scope_json, '$.perms') IS NULL THEN
    json_object(
      'kind', 'fs',
      'rule', json_object('kind', 'path', 'root', 'absolute', 'behavior', 'prefix', 'value', json_extract(scope_json, '$.rule.path'))
    )
  ELSE
    json_object(
      'kind', 'fs',
      'perms', json(json_extract(scope_json, '$.perms')),
      'rule', json_object('kind', 'path', 'root', 'absolute', 'behavior', 'prefix', 'value', json_extract(scope_json, '$.rule.path'))
    )
  END
WHERE scope_json IS NOT NULL
  AND json_valid(scope_json)
  AND json_extract(scope_json, '$.kind') = 'fs'
  AND json_extract(scope_json, '$.rule.kind') = 'prefix'
  AND json_type(scope_json, '$.rule.path') = 'text'
  AND length(json_extract(scope_json, '$.rule.path')) > 0;
