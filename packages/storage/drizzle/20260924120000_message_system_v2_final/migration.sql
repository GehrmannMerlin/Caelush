-- Phase 5F — final Message System V2 physical schema.
--
-- This file is applied by the storage migration orchestrator only after the deterministic
-- legacy backfill has proved that every row has a complete AgentMessageRecord envelope and
-- payload. It is intentionally not safe to run before that gate: v2_data_json is the source
-- for the final data_json column during the table copy.

CREATE TABLE `agent_messages__phase5f` (
	`message_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL REFERENCES `agent_runs`(`id`),
	`session_id` text NOT NULL REFERENCES `agent_sessions`(`id`),
	`sequence` integer NOT NULL,
	`conversation_turn_id` text NOT NULL,
	`message_type` text NOT NULL,
	`schema_version` integer NOT NULL,
	`model_projection_version` integer,
	`source_step_id` text REFERENCES `agent_steps`(`id`),
	`created_at_ms` integer NOT NULL,
	`source_json` text NOT NULL,
	`audience_json` text NOT NULL,
	`data_json` text NOT NULL,
	UNIQUE(`run_id`, `sequence`)
);
--> statement-breakpoint
INSERT INTO `agent_messages__phase5f`
  (`message_id`, `run_id`, `session_id`, `sequence`, `conversation_turn_id`, `message_type`,
   `schema_version`, `model_projection_version`, `source_step_id`, `created_at_ms`, `source_json`,
   `audience_json`, `data_json`)
SELECT `message_id`, `run_id`, `session_id`, `sequence`, `conversation_turn_id`, `message_type`,
       `schema_version`, `model_projection_version`, `source_step_id`, `created_at_ms`, `source_json`,
       `audience_json`, `v2_data_json`
FROM `agent_messages`;
--> statement-breakpoint
DROP TABLE `agent_messages`;
--> statement-breakpoint
ALTER TABLE `agent_messages__phase5f` RENAME TO `agent_messages`;
--> statement-breakpoint
CREATE INDEX `agent_messages_run_sequence_idx` ON `agent_messages` (`run_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `agent_messages_session_created_idx` ON `agent_messages` (`session_id`, `created_at_ms`);
--> statement-breakpoint
CREATE INDEX `agent_messages_turn_sequence_idx` ON `agent_messages` (`conversation_turn_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `agent_messages_type_idx` ON `agent_messages` (`message_type`);
