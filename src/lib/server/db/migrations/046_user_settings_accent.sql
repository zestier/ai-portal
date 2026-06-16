-- 046_user_settings_accent.sql
--
-- Selectable accent palette, orthogonal to the existing dark/light/system
-- theme mode. Lets each portal instance be tinted a distinct colour so copies
-- running for different projects are easy to tell apart. Defaults to 'default'
-- (the per-mode blue), preserving the current look for every existing user.

ALTER TABLE user_settings
  ADD COLUMN accent TEXT NOT NULL DEFAULT 'default';
