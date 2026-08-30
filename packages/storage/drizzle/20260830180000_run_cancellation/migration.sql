CREATE TABLE `run_cancellation_requests` (
	`run_id` text PRIMARY KEY NOT NULL,
	`cause` text NOT NULL,
	`requested_at_ms` integer NOT NULL,
	CONSTRAINT `fk_run_cancellation_requests_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE INDEX `run_cancellation_requests_requested_at_idx` ON `run_cancellation_requests` (`requested_at_ms`);
