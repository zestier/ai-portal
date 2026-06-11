-- 042_conversation_memory_extractor_backend.sql
--
-- Per-conversation override for the model-backed memory extractor backend,
-- mirroring the existing per-conversation `memory_extractor_model` override.
-- Nullable: NULL means "use the server default" (env MEMORY_EXTRACTOR_BACKEND),
-- so every existing conversation keeps its current behaviour. Seeded from the
-- user's default at creation; never retroactively changed.

ALTER TABLE conversations ADD COLUMN memory_extractor_backend TEXT;
