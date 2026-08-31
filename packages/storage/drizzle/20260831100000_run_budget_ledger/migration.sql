CREATE TABLE `run_budget_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`reserved_tool_calls` integer NOT NULL,
	`reserved_input_tokens` integer NOT NULL,
	`reserved_output_tokens` integer NOT NULL,
	`actual_input_tokens` integer,
	`actual_output_tokens` integer,
	`reserved_cost_micros` integer NOT NULL,
	`actual_cost_micros` integer,
	`model_provider` text,
	`model_id` text,
	`pricing_snapshot_id` text,
	`input_rate_micros_per_million` integer,
	`output_rate_micros_per_million` integer,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`settled_at_ms` integer,
	CONSTRAINT `fk_run_budget_entries_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_budget_entries_owner_unique` ON `run_budget_entries` (`run_id`,`kind`,`owner_id`);
--> statement-breakpoint
CREATE INDEX `run_budget_entries_run_id_idx` ON `run_budget_entries` (`run_id`);
--> statement-breakpoint
CREATE INDEX `run_budget_entries_state_idx` ON `run_budget_entries` (`state`);
