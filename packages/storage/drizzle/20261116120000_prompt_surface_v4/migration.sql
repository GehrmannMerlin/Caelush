CREATE TABLE `prompt_surface_epochs_v4` (
	`run_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`format_version` integer NOT NULL DEFAULT 2 CHECK (`format_version` IN (2, 3, 4)),
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`stable_head_fingerprint` text NOT NULL,
	`tool_schema_fingerprint` text NOT NULL,
	`cache_settings_fingerprint` text NOT NULL,
	`reset_reason` text NOT NULL,
	`created_step_sequence` integer NOT NULL CHECK (`created_step_sequence` >= 1),
	`created_at_ms` integer NOT NULL CHECK (`created_at_ms` >= 0),
	PRIMARY KEY (`run_id`, `epoch_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `prompt_surface_epochs_v4`
	(`run_id`, `epoch_id`, `format_version`, `model_provider`, `model_id`, `stable_head_fingerprint`,
	 `tool_schema_fingerprint`, `cache_settings_fingerprint`, `reset_reason`, `created_step_sequence`, `created_at_ms`)
SELECT `run_id`, `epoch_id`, `format_version`, `model_provider`, `model_id`, `stable_head_fingerprint`,
	 `tool_schema_fingerprint`, `cache_settings_fingerprint`, `reset_reason`, `created_step_sequence`, `created_at_ms`
FROM `prompt_surface_epochs`;
--> statement-breakpoint
DROP TABLE `prompt_surface_epochs`;
--> statement-breakpoint
ALTER TABLE `prompt_surface_epochs_v4` RENAME TO `prompt_surface_epochs`;
