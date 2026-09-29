ALTER TABLE `agent_sessions` ADD COLUMN `workspace_id` text;
--> statement-breakpoint
CREATE INDEX `agent_sessions_workspace_id_idx` ON `agent_sessions` (`workspace_id`);
