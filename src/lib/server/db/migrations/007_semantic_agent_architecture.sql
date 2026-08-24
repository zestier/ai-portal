ALTER TABLE conversations
  ADD COLUMN agent_architecture TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE conversations
  ADD COLUMN semantic_worker_model TEXT;