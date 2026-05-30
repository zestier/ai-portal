CREATE TABLE memory_patch_items (
  id              TEXT PRIMARY KEY,
  patch_id        TEXT NOT NULL REFERENCES memory_patches(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  item_type       TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  action          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_memory_patch_items_patch
  ON memory_patch_items(patch_id);
CREATE INDEX idx_memory_patch_items_conv_item
  ON memory_patch_items(conversation_id, item_type, item_id);
