ALTER TABLE `prompt_surface_snapshots` ADD COLUMN `anchor_message_id` text;
--> statement-breakpoint
ALTER TABLE `prompt_surface_snapshots` ADD COLUMN `anchor_run_id` text;
--> statement-breakpoint
ALTER TABLE `prompt_surface_snapshots` ADD COLUMN `anchor_conversation_turn_id` text;
