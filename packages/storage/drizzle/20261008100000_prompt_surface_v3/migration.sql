ALTER TABLE `prompt_surface_epochs` ADD COLUMN `format_version` integer NOT NULL DEFAULT 2 CHECK (`format_version` IN (2, 3));
--> statement-breakpoint
DROP INDEX IF EXISTS `prompt_surface_epochs_run_step_unique`;
--> statement-breakpoint
CREATE TABLE `prompt_surface_records` (
	`run_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`ordinal` integer NOT NULL CHECK (`ordinal` >= 1),
	`anchor_message_sequence` integer NOT NULL CHECK (`anchor_message_sequence` >= 1),
	`anchor_message_id` text NOT NULL,
	`anchor_run_id` text NOT NULL,
	`anchor_conversation_turn_id` text NOT NULL,
	`source_step_sequence` integer NOT NULL CHECK (`source_step_sequence` >= 1),
	`kind` text NOT NULL CHECK (`kind` IN ('BASELINE', 'DELTA', 'NOOP')),
	`updates_json` text NOT NULL,
	`decision_fingerprint` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_length` integer NOT NULL CHECK (`byte_length` >= 0),
	`created_at_ms` integer NOT NULL CHECK (`created_at_ms` >= 0),
	PRIMARY KEY (`run_id`, `epoch_id`, `ordinal`),
	FOREIGN KEY (`run_id`, `epoch_id`) REFERENCES `prompt_surface_epochs`(`run_id`, `epoch_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_surface_records_source_step_unique` ON `prompt_surface_records` (`run_id`, `epoch_id`, `source_step_sequence`);
--> statement-breakpoint
CREATE TABLE `prompt_surface_section_state` (
	`run_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`state_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`content` text NOT NULL,
	`updated_ordinal` integer NOT NULL CHECK (`updated_ordinal` >= 1),
	PRIMARY KEY (`run_id`, `epoch_id`, `state_key`),
	FOREIGN KEY (`run_id`, `epoch_id`) REFERENCES `prompt_surface_epochs`(`run_id`, `epoch_id`) ON UPDATE no action ON DELETE cascade
);
