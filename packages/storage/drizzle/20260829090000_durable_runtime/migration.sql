CREATE TABLE `agent_messages` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`role` text NOT NULL,
	`source_step_id` text,
	`protocol_version` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_agent_messages_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`),
	CONSTRAINT `fk_agent_messages_source_step_id_agent_steps_id_fk` FOREIGN KEY (`source_step_id`) REFERENCES `agent_steps`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_run_sequence_unique` ON `agent_messages` (`run_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `agent_messages_run_sequence_idx` ON `agent_messages` (`run_id`,`sequence`);
