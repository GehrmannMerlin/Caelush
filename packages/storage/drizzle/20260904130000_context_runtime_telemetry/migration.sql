ALTER TABLE `context_runtime_states` ADD COLUMN `raw_context_window_tokens` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `context_runtime_states` ADD COLUMN `last_build_at_ms` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `context_runtime_states` ADD COLUMN `last_recovery_stages_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint

UPDATE `context_runtime_states`
SET `raw_context_window_tokens` = `context_window_tokens`,
    `last_build_at_ms` = `updated_at_ms`
WHERE `raw_context_window_tokens` = 0;
