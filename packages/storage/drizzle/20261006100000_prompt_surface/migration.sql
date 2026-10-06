CREATE TABLE `prompt_surface_epochs` (
	`run_id` text NOT NULL,
	`epoch_id` text NOT NULL,
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
CREATE UNIQUE INDEX `prompt_surface_epochs_run_step_unique` ON `prompt_surface_epochs` (`run_id`, `created_step_sequence`);
--> statement-breakpoint
CREATE TABLE `prompt_surface_snapshots` (
	`run_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`ordinal` integer NOT NULL CHECK (`ordinal` >= 1),
	`anchor_message_sequence` integer NOT NULL CHECK (`anchor_message_sequence` >= 1),
	`source_step_sequence` integer NOT NULL CHECK (`source_step_sequence` >= 1),
	`kind` text NOT NULL CHECK (`kind` = 'RUNTIME_CONTEXT_SNAPSHOT'),
	`content_hash` text NOT NULL,
	`byte_length` integer NOT NULL CHECK (`byte_length` >= 0),
	`created_at_ms` integer NOT NULL CHECK (`created_at_ms` >= 0),
	`content` text NOT NULL,
	PRIMARY KEY (`run_id`, `epoch_id`, `ordinal`),
	FOREIGN KEY (`run_id`, `epoch_id`) REFERENCES `prompt_surface_epochs`(`run_id`, `epoch_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_surface_snapshots_source_step_unique` ON `prompt_surface_snapshots` (`run_id`, `epoch_id`, `source_step_sequence`);
