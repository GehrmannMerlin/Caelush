CREATE TABLE `agent_events` (
	`event_id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`aggregate_sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`event_schema_version` integer NOT NULL,
	`visibility` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_agent_events_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`),
	CONSTRAINT `fk_agent_events_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`),
	CONSTRAINT `fk_agent_events_step_id_agent_steps_id_fk` FOREIGN KEY (`step_id`) REFERENCES `agent_steps`(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`status` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`finished_at_ms` integer,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_agent_runs_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY,
	`protocol_version` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_state_snapshots` (
	`run_id` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_agent_state_snapshots_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_steps` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`started_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_agent_steps_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE TABLE `event_sequences` (
	`run_id` text PRIMARY KEY,
	`last_sequence` integer NOT NULL,
	CONSTRAINT `fk_event_sequences_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_events_run_sequence_unique` ON `agent_events` (`run_id`,`aggregate_sequence`);--> statement-breakpoint
CREATE INDEX `agent_events_run_sequence_idx` ON `agent_events` (`run_id`,`aggregate_sequence`);--> statement-breakpoint
CREATE INDEX `agent_runs_session_id_idx` ON `agent_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_session_created_at_idx` ON `agent_runs` (`session_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `agent_runs_status_idx` ON `agent_runs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_steps_run_sequence_unique` ON `agent_steps` (`run_id`,`sequence`);