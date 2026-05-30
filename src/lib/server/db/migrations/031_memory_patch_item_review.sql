ALTER TABLE memory_patch_items ADD COLUMN review_status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE memory_patch_items ADD COLUMN reviewed_at INTEGER;
