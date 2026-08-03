-- 067_permission_shadow_decisions.sql
--
-- Phase 0 of the "adversarial approval mode" exploration: a second model reads
-- prompt-worthy permission requests and records what it *would* have decided,
-- with no authority whatsoever. The point is to get a real precision/recall
-- number for adversary denials against the human's actual clicks before the
-- adversary is ever allowed to gate anything.
--
-- Deliberately a separate table rather than nullable columns on
-- `permission_decisions`:
--   * a shadow row is not a decision — nothing in the system acted on it — and
--     the settings audit panel reads `permission_decisions` as "what happened".
--     Mixing the two would make every existing consumer of that table have to
--     learn the difference.
--   * shadow rows are written in two independent steps (the adversary's verdict
--     and, later, the human's label), which is an awkward shape for a table
--     whose rows are otherwise written once and never updated.
--
-- `human_decision` NULL means "no human label": the prompt was cancelled,
-- expired, or the turn was abandoned before anyone clicked. Those rows are
-- EXCLUDED from scoring rather than counted as denials — a cancelled prompt is
-- explicitly not a denial (see `interactive-requests.cancel`).
--
-- Two limitations to keep in mind when reading this data, both recorded here
-- rather than discovered later:
--   * The human's click is not ground truth, only a label. A human who
--     rubber-stamps a dangerous request makes a correct adversary denial look
--     like a false positive. The metrics are agreement with the human, not
--     correctness; `human_decided_at - created_at` is kept as a (weak)
--     rubber-stamping proxy.
--   * The sampled population is skewed. Rows with `resolution_source` of
--     'prompt-grant'/'prompt-policy' are requests that reached a human in an
--     `ask` conversation; 'auto-approve' rows are the population a veto
--     product would gate but carry no human label at all. Neither set is a
--     random sample of the other.

CREATE TABLE permission_shadow_decisions (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool             TEXT NOT NULL,
  permission_kind  TEXT NOT NULL,
  scope_key        TEXT,
  args_hash        TEXT,
  adversary_model  TEXT NOT NULL,
  -- Identity of the experiment this row belongs to: a hash over the system
  -- prompt, renderer version, truncation budget and model name. Measurements
  -- taken under different setups are different experiments; pooling them
  -- produces a meaningless average, so the readout stratifies on this rather
  -- than trusting anyone to have remembered to bump a version number.
  experiment_key   TEXT NOT NULL,
  -- Human-readable companion to experiment_key. Hand-maintained, so it is a
  -- label, not the thing analysis groups by.
  prompt_version   INTEGER NOT NULL DEFAULT 1,
  -- Stable hash of the exact fact set shown to the model. Also the memo key,
  -- so repeat askings of the same question can be clustered (they are not
  -- independent samples) without storing the facts twice.
  facts_key        TEXT,
  -- The exact user prompt that was sent, verbatim. This is what makes a
  -- disagreement adjudicable and a prompt change re-runnable against old
  -- cases; without it the row records a verdict on inputs nobody can
  -- reconstruct. It is the same bytes that went over the network — already
  -- truncated to ADVERSARY_SHADOW_MAX_ARG_CHARS — rather than the untruncated
  -- facts, so the copy at rest is never larger than what the operator already
  -- accepted sending to the provider.
  prompt_sent      TEXT,
  -- Why this request needed a decision:
  --   'prompt-grant'  — a stored grant demanded a prompt
  --   'prompt-policy' — no grant matched and policy said prompt
  --   'auto-approve'  — nobody was asked; the conversation is in auto-approve
  -- The first two are the labelled `ask` population. The third is the
  -- population an eventual veto product would gate: unlabelled by
  -- construction, excluded from scoring, and collected anyway because the
  -- request cannot be recovered after the fact.
  resolution_source TEXT,
  -- 'pending' until the adversary call settles; then 'verdict' or 'error'.
  -- A row stuck at 'pending' means the process died (or the call never
  -- returned) — visible, and excluded from scoring like any non-verdict row.
  status           TEXT NOT NULL,
  -- 'allow' | 'deny'. NULL unless status = 'verdict'.
  verdict          TEXT,
  -- Model's estimated probability that a careful operator would REJECT the
  -- request, or NULL when it gave none. Deliberately a deny probability rather
  -- than "confidence in the verdict", which flips meaning with the verdict and
  -- is incoherent below 0.5. Unused by Phase 0 scoring; captured so a later
  -- analysis can sweep a threshold and produce a precision/recall CURVE
  -- instead of the single arbitrary operating point a bare binary verdict pins
  -- you to. Adding it later would mean re-collecting every row.
  deny_probability REAL,
  rationale        TEXT,
  error            TEXT,
  latency_ms       INTEGER,
  -- 1 when this row reused a memoized verdict from an identical earlier
  -- request in the same session instead of paying for its own provider call.
  -- Memoized rows are perfectly correlated with their source row, so the
  -- headline metrics are computed over non-memoized rows only; an agent retry
  -- loop must not get to vote N times on whether this mode ships.
  memoized         INTEGER NOT NULL DEFAULT 0,
  -- The human's actual click, using the same vocabulary as
  -- `permission_decisions.decision`. NULL = no human label; see above.
  human_decision   TEXT,
  human_decided_at INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_permission_shadow_decisions_conv
  ON permission_shadow_decisions(conversation_id, created_at DESC);
