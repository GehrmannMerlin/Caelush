CREATE TABLE `run_resource_states` (
	`run_id` text PRIMARY KEY NOT NULL,
	`policy_version` text NOT NULL,
	`mode` text NOT NULL,
	`lease_epoch` integer NOT NULL,
	`lease_start_agent_turns` integer NOT NULL,
	`lease_start_tool_calls` integer NOT NULL,
	`agent_turns_consumed` integer NOT NULL,
	`tool_operations_consumed` integer NOT NULL,
	`last_progress_at_ms` integer,
	`consecutive_no_progress_turns` integer NOT NULL,
	`replan_count` integer NOT NULL,
	`resource_guard_state` text NOT NULL,
	`revision` integer NOT NULL,
	`recent_fingerprints_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_run_resource_states_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
--> statement-breakpoint
CREATE INDEX `run_resource_states_guard_state_idx` ON `run_resource_states` (`resource_guard_state`);
