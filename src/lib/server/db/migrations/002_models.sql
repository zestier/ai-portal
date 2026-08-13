-- 002_models.sql
-- Portal-managed model/provider configuration (ticket #3).
--
-- These tables are the portal's internal source of truth for what models a
-- turn may run. They are serialized into a pi models.json under DATA_DIR and
-- loaded into the shared ModelRuntime (see src/lib/server/models/models-json.ts
-- and src/lib/server/pi/index.ts). Provider API keys live here encrypted
-- (api_key_ct, AES-256-GCM via ENCRYPTION_KEY) — the portal never depends on
-- provider keys in the process environment.

CREATE TABLE providers (
  id           TEXT PRIMARY KEY,               -- pi provider id, e.g. 'anthropic', 'ollama'
  name         TEXT NOT NULL,                  -- human label shown in the portal
  api          TEXT NOT NULL,                  -- 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai'
  base_url     TEXT,                           -- custom endpoint; NULL keeps the pi default for built-in providers
  api_key_ct   BLOB,                           -- encrypted key; NULL when unset / keyless local server
  headers_json TEXT NOT NULL DEFAULT '{}',     -- extra request headers (e.g. x-portkey-api-key)
  auth_header  INTEGER NOT NULL DEFAULT 0,     -- models.json authHeader flag (advanced; rarely needed)
  builtin      INTEGER NOT NULL DEFAULT 0,     -- 1 = pi bundled provider (models merge with pi's catalog)
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE models (
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,             -- model id sent to the API (e.g. 'claude-sonnet-4-5')
  name              TEXT NOT NULL,             -- human label
  purpose           TEXT,                      -- portal-only annotation: what the model is for ('coding', 'cheap', 'vision', ...)
  enabled           INTEGER NOT NULL DEFAULT 1,
  cost_json         TEXT NOT NULL DEFAULT '{}',-- per-million-token rates {input, output, cacheRead, cacheWrite, tiers?}
  context_window    INTEGER,                   -- tokens
  max_tokens        INTEGER,                   -- max output tokens
  reasoning         INTEGER NOT NULL DEFAULT 0,
  input_json        TEXT NOT NULL DEFAULT '["text"]',
  thinking_map_json TEXT,                      -- {off:null, high:'high', ...}
  compat_json       TEXT,                      -- {supportsDeveloperRole: false, ...}
  sampling_json     TEXT,                      -- free-form sampling params merged into requests
  sort_order        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, id),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) WITHOUT ROWID;
