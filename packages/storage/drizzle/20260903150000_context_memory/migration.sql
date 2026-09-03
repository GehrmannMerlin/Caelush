CREATE TABLE `context_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`previous_checkpoint_id` text,
	`source_sequence_from` integer NOT NULL,
	`source_sequence_to` integer NOT NULL,
	`tokens_before` integer NOT NULL,
	`tokens_after` integer NOT NULL,
	`summary_version` integer NOT NULL,
	`model_ref_json` text,
	`created_at_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	`read_file_refs_json` text NOT NULL,
	`changed_file_refs_json` text NOT NULL,
	CONSTRAINT `fk_context_checkpoints_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE INDEX `context_checkpoints_run_sequence_idx` ON `context_checkpoints` (`run_id`,`source_sequence_to`);
--> statement-breakpoint
CREATE TABLE `context_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_ref` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_length` integer NOT NULL,
	`mime_type` text NOT NULL,
	`sensitivity` text NOT NULL,
	`created_sequence` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `fk_context_artifacts_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE INDEX `context_artifacts_run_id_idx` ON `context_artifacts` (`run_id`);
--> statement-breakpoint
CREATE TABLE `memory_records` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`topic` text NOT NULL,
	`fact` text NOT NULL,
	`status` text NOT NULL,
	`confidence` integer NOT NULL,
	`evidence_refs_json` text NOT NULL,
	`source_run_ids_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`last_confirmed_at_ms` integer NOT NULL,
	`supersedes` text,
	`superseded_by` text,
	`sensitivity` text NOT NULL,
	`schema_version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_records_scope_project_idx` ON `memory_records` (`scope`,`project_id`);
