-- 069_adversary_backend.sql
--
-- The Phase 0 adversary shadow originally *required* `OPENAI_COMPATIBLE_BASE_URL`:
-- `resolveConfig` returned null without it, so the shadow could only ever run in
-- deployments that stood up a second endpoint — not the default one.
--
-- That coupling conflated two unrelated things. Wanting the reviewer not to
-- share the agent's weights argues for a different MODEL. It says nothing about
-- the BACKEND. The Copilot backend already serves several independent model
-- families (different vendors, different weights), so the independence the
-- experiment wants was available all along without a second endpoint.
--
-- The egress argument runs the other way too: the chat backend already receives
-- the whole conversation, tool calls and arguments included, so reviewing those
-- same arguments there adds no new destination. Mandating a second provider is
-- what widened the blast radius, by involving a party that would otherwise see
-- none of it.
--
-- So the backend becomes an explicit, independently-chosen dimension:
--   conversation column -> user default -> env ADVERSARY_SHADOW_BACKEND
--   -> the conversation's OWN chat backend.
-- The last fallback is what makes the default deployment able to collect data.
--
-- `adversary_backend` on the shadow rows is NOT redundant with adversary_model:
-- the same model NAME served by two backends is not the same experiment (the
-- weights, the system-prompt handling and the structured-output support all
-- differ), so it is folded into `experiment_key` as well. Rows predating this
-- migration have NULL, which reads correctly as "collected when
-- openai-compatible was the only possibility".

ALTER TABLE permission_shadow_decisions ADD COLUMN adversary_backend TEXT;
ALTER TABLE user_settings ADD COLUMN default_adversary_backend TEXT;
ALTER TABLE conversations ADD COLUMN adversary_backend TEXT;
