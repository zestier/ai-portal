-- 006_provider_compat.sql
-- Provider-level compat for pi models.json. pi reads provider-level `compat`
-- as defaults merged into every model under the provider, with model-level
-- compat overriding on top (OpenRouter routing is a compat field). Mirrors the
-- existing models.compat_json column.
ALTER TABLE providers ADD COLUMN compat_json TEXT;