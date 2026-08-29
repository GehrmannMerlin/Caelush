CREATE TABLE `tool_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`external_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`status` text NOT NULL,
	`risk_level` text NOT NULL,
	`revision` integer NOT NULL,
	`protocol_version` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`finished_at_ms` integer,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_tool_invocations_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`),
	CONSTRAINT `fk_tool_invocations_step_id_agent_steps_id_fk` FOREIGN KEY (`step_id`) REFERENCES `agent_steps`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_invocations_run_step_external_call_unique` ON `tool_invocations` (`run_id`,`step_id`,`external_call_id`);
--> statement-breakpoint
CREATE INDEX `tool_invocations_run_id_idx` ON `tool_invocations` (`run_id`);
--> statement-breakpoint
CREATE INDEX `tool_invocations_step_id_idx` ON `tool_invocations` (`step_id`);
--> statement-breakpoint
CREATE INDEX `tool_invocations_status_idx` ON `tool_invocations` (`status`);
--> statement-breakpoint
CREATE TABLE `agent_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`kind` text NOT NULL,
	`tool_invocation_id` text,
	`protocol_version` integer NOT NULL,
	`is_error` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_agent_observations_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`),
	CONSTRAINT `fk_agent_observations_step_id_agent_steps_id_fk` FOREIGN KEY (`step_id`) REFERENCES `agent_steps`(`id`),
	CONSTRAINT `fk_agent_observations_tool_invocation_id_tool_invocations_id_fk` FOREIGN KEY (`tool_invocation_id`) REFERENCES `tool_invocations`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_observations_tool_invocation_unique` ON `agent_observations` (`tool_invocation_id`);
--> statement-breakpoint
CREATE INDEX `agent_observations_run_id_idx` ON `agent_observations` (`run_id`);
--> statement-breakpoint
CREATE INDEX `agent_observations_step_id_idx` ON `agent_observations` (`step_id`);
