CREATE TABLE `context_checkpoints_v3` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`previous_checkpoint_id` text,
	`owner_step_sequence` integer,
	`activation_operation_id` text,
	`coverage_digest` text,
	`source_sequence_from` integer,
	`source_sequence_to` integer,
	`tokens_before` integer NOT NULL,
	`tokens_after` integer NOT NULL,
	`summary_version` integer NOT NULL,
	`model_ref_json` text,
	`created_at_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	`read_file_refs_json` text NOT NULL,
	`changed_file_refs_json` text NOT NULL,
	CONSTRAINT `context_checkpoints_schema_coverage_check` CHECK (
		(`summary_version` IN (1, 2) AND `source_sequence_from` IS NOT NULL AND `source_sequence_to` IS NOT NULL AND `owner_step_sequence` IS NULL AND `activation_operation_id` IS NULL AND `coverage_digest` IS NULL)
		OR (`summary_version` = 3 AND `source_sequence_from` IS NULL AND `source_sequence_to` IS NULL AND `owner_step_sequence` > 0 AND `activation_operation_id` IS NOT NULL AND `coverage_digest` IS NOT NULL)
	),
	CONSTRAINT `fk_context_checkpoints_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`),
	CONSTRAINT `fk_context_checkpoints_session_id_agent_sessions_id` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`)
);
--> statement-breakpoint
INSERT INTO `context_checkpoints_v3`
	(`id`, `run_id`, `session_id`, `previous_checkpoint_id`, `owner_step_sequence`, `activation_operation_id`, `coverage_digest`, `source_sequence_from`, `source_sequence_to`, `tokens_before`, `tokens_after`, `summary_version`, `model_ref_json`, `created_at_ms`, `data_json`, `read_file_refs_json`, `changed_file_refs_json`)
SELECT `checkpoint`.`id`, `checkpoint`.`run_id`, `run`.`session_id`, `checkpoint`.`previous_checkpoint_id`, NULL, NULL, NULL, `checkpoint`.`source_sequence_from`, `checkpoint`.`source_sequence_to`, `checkpoint`.`tokens_before`, `checkpoint`.`tokens_after`, `checkpoint`.`summary_version`, `checkpoint`.`model_ref_json`, `checkpoint`.`created_at_ms`, `checkpoint`.`data_json`, `checkpoint`.`read_file_refs_json`, `checkpoint`.`changed_file_refs_json`
FROM `context_checkpoints` AS `checkpoint`
INNER JOIN `agent_runs` AS `run` ON `run`.`id` = `checkpoint`.`run_id`;
--> statement-breakpoint
DROP TABLE `context_checkpoints`;
--> statement-breakpoint
ALTER TABLE `context_checkpoints_v3` RENAME TO `context_checkpoints`;
--> statement-breakpoint
CREATE INDEX `context_checkpoints_run_sequence_idx` ON `context_checkpoints` (`run_id`,`source_sequence_to`);
--> statement-breakpoint
CREATE INDEX `context_checkpoints_session_owner_idx` ON `context_checkpoints` (`session_id`,`run_id`,`owner_step_sequence`);
--> statement-breakpoint
CREATE TABLE `context_compaction_activations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`checkpoint_id` text NOT NULL UNIQUE,
	`session_id` text NOT NULL,
	`owner_run_id` text NOT NULL,
	`owner_step_sequence` integer NOT NULL,
	`epoch_id` text NOT NULL,
	`baseline_fingerprint` text NOT NULL,
	CONSTRAINT `context_compaction_activations_owner_step_check` CHECK (`owner_step_sequence` > 0),
	CONSTRAINT `context_compaction_activations_baseline_fingerprint_check` CHECK (substr(`baseline_fingerprint`, 1, 7) = 'sha256:' AND length(`baseline_fingerprint`) = 71 AND substr(`baseline_fingerprint`, 8) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `fk_context_compaction_activations_checkpoint_id_context_checkpoints_id` FOREIGN KEY (`checkpoint_id`) REFERENCES `context_checkpoints`(`id`),
	CONSTRAINT `fk_context_compaction_activations_session_id_agent_sessions_id` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`),
	CONSTRAINT `fk_context_compaction_activations_owner_run_id_agent_runs_id` FOREIGN KEY (`owner_run_id`) REFERENCES `agent_runs`(`id`)
);
