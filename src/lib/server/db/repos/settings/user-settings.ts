import { getDb } from "../../index";
import type { UserSettings } from "$lib/types";
import { rowToSettings, type SettingsRow } from "./rows";

export function get(userId: number): UserSettings | null {
  const r = getDb()
    .prepare("SELECT * FROM user_settings WHERE user_id = ?")
    .get(userId) as SettingsRow | undefined;
  return r ? rowToSettings(r) : null;
}

/**
 * Default settings for users who have never saved a preference. Callers
 * typically use `settings.get(userId) ?? settings.defaults()` rather than
 * a synthetic-default `getOrDefault` (per the repo convention: `getX → X | null`).
 */
export function defaults(): UserSettings {
  return {
    defaultModel: null,
    defaultWorkdir: null,
    defaultConversationMode: "interactive",
    defaultApprovalMode: "ask",
    defaultPolicy: "prompt",
    theme: "system",
    accent: "default",
    defaultPromptTemplateId: null,
  };
}

export function save(userId: number, s: UserSettings) {
  getDb()
    .prepare(
      `INSERT INTO user_settings(
			   user_id, default_model, default_workdir, default_mode, default_approval_mode, default_policy, theme, accent, default_prompt_template_id, updated_at
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   default_model = excluded.default_model,
			   default_workdir = excluded.default_workdir,
			   default_mode = excluded.default_mode,
			   default_approval_mode = excluded.default_approval_mode,
			   default_policy = excluded.default_policy,
			   theme = excluded.theme,
			   accent = excluded.accent,
			   default_prompt_template_id = excluded.default_prompt_template_id,
			   updated_at = excluded.updated_at`,
    )
    .run(
      userId,
      s.defaultModel,
      s.defaultWorkdir,
      s.defaultConversationMode,
      s.defaultApprovalMode,
      s.defaultPolicy,
      s.theme,
      s.accent,
      s.defaultPromptTemplateId,
      Date.now(),
    );
}
