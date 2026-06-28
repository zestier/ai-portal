-- 058_messages_fts.sql
--
-- `messages.searchConversation` filtered with `instr(lower(content), lower(?))`,
-- a per-row function call that cannot use an index and scans every message in a
-- conversation (potentially MBs of text). Add an FTS5 virtual table that mirrors
-- message content so search is index-backed, and back a future sidebar/global
-- conversation search feature.
--
-- The index keeps `conversation_id` / `message_id` UNINDEXED (stored, not
-- tokenized) so we can filter/join without tokenizing ULIDs, and tokenizes
-- `content` with the trigram tokenizer. Trigram supports fast arbitrary
-- substring MATCH (3+ chars), preserving the old `instr` substring contract
-- rather than the whole-token matching of the default tokenizer. Triggers keep
-- it in sync on insert/update/delete. Like `memory_search_index`, FTS5 virtual
-- tables can't be FK cascade targets, so the delete trigger on `messages` is
-- what cleans index rows when a conversation is removed (CASCADE deletes the
-- messages, which fires the trigger).

CREATE VIRTUAL TABLE messages_fts USING fts5(
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

INSERT INTO messages_fts(conversation_id, message_id, content)
  SELECT conversation_id, id, content FROM messages;

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(conversation_id, message_id, content)
    VALUES (new.conversation_id, new.id, new.content);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(conversation_id, message_id, content)
    VALUES (new.conversation_id, new.id, new.content);
END;
