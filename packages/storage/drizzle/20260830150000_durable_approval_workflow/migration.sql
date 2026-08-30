CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_invocation_id` text NOT NULL,
	`approval_key` text NOT NULL,
	`status` text NOT NULL,
	`scope` text NOT NULL,
	`granted_scope` text,
	`risk_level` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer,
	`resolved_at_ms` integer,
	`data_json` text NOT NULL,
	CONSTRAINT `approval_requests_tool_invocation_unique` UNIQUE(`tool_invocation_id`),
	CONSTRAINT `fk_approval_requests_run_id_agent_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`),
	CONSTRAINT `fk_approval_requests_tool_invocation_id_tool_invocations_id_fk` FOREIGN KEY (`tool_invocation_id`) REFERENCES `tool_invocations`(`id`)
);
--> statement-breakpoint
CREATE INDEX `approval_requests_run_id_idx` ON `approval_requests` (`run_id`);
--> statement-breakpoint
CREATE INDEX `approval_requests_status_idx` ON `approval_requests` (`status`);
--> statement-breakpoint
CREATE INDEX `approval_requests_run_status_idx` ON `approval_requests` (`run_id`,`status`);
--> statement-breakpoint
CREATE INDEX `approval_requests_run_key_idx` ON `approval_requests` (`run_id`,`approval_key`);
