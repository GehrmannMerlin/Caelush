CREATE TABLE `verification_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_step_id` text NOT NULL,
	`planner_version` text NOT NULL,
	`plan_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_verification_plans_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`),
	CONSTRAINT `fk_verification_plans_source_step_id_agent_steps_id` FOREIGN KEY (`source_step_id`) REFERENCES `agent_steps`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_plans_run_source_unique` ON `verification_plans` (`run_id`,`source_step_id`);
--> statement-breakpoint
CREATE INDEX `verification_plans_run_id_idx` ON `verification_plans` (`run_id`);
--> statement-breakpoint
CREATE TABLE `verification_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`stage` text NOT NULL,
	`requirement` text NOT NULL,
	`status` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`finished_at_ms` integer,
	`skip_reason` text,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_verification_checks_plan_id_verification_plans_id` FOREIGN KEY (`plan_id`) REFERENCES `verification_plans`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_checks_plan_ordinal_unique` ON `verification_checks` (`plan_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `verification_checks_plan_id_idx` ON `verification_checks` (`plan_id`);
--> statement-breakpoint
CREATE INDEX `verification_checks_status_idx` ON `verification_checks` (`status`);
--> statement-breakpoint
CREATE TABLE `verification_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`check_id` text NOT NULL,
	`kind` text NOT NULL,
	`captured_at_ms` integer NOT NULL,
	`data_json` text NOT NULL,
	CONSTRAINT `fk_verification_evidence_plan_id_verification_plans_id` FOREIGN KEY (`plan_id`) REFERENCES `verification_plans`(`id`),
	CONSTRAINT `fk_verification_evidence_check_id_verification_checks_id` FOREIGN KEY (`check_id`) REFERENCES `verification_checks`(`id`)
);
--> statement-breakpoint
CREATE INDEX `verification_evidence_plan_id_idx` ON `verification_evidence` (`plan_id`);
--> statement-breakpoint
CREATE INDEX `verification_evidence_check_id_idx` ON `verification_evidence` (`check_id`);
