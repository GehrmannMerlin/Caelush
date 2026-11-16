CREATE TABLE `prepared_input_resource_receipts` (
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`projection_fingerprint` text NOT NULL,
	`renderer_version` text NOT NULL,
	PRIMARY KEY (`run_id`, `step_id`, `binding_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `agent_steps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`binding_id`) REFERENCES `run_prepared_resources`(`binding_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `prepared_input_resource_receipts_run_step_idx`
	ON `prepared_input_resource_receipts` (`run_id`, `step_id`);
