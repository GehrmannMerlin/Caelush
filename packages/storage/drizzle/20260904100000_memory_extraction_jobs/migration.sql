CREATE TABLE `memory_extraction_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`last_error` text,
	CONSTRAINT `fk_memory_extraction_jobs_source_run_id_agent_runs_id` FOREIGN KEY (`source_run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_extraction_jobs_source_run_idx` ON `memory_extraction_jobs` (`source_run_id`);
--> statement-breakpoint
CREATE INDEX `memory_extraction_jobs_status_idx` ON `memory_extraction_jobs` (`status`,`created_at_ms`);
