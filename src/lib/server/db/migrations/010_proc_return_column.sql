-- Rename proc_transactions.goal to contract_text (the final return contract
-- the frontier requests, shaped by the worker). 'contract' lives in the TS
-- output policy; the column keeps a _text suffix for SQLite.
ALTER TABLE proc_transactions RENAME COLUMN goal TO contract_text;
