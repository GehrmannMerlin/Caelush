ALTER TABLE `run_budget_entries` ADD COLUMN `cache_hit_input_tokens` integer;
--> statement-breakpoint
ALTER TABLE `run_budget_entries` ADD COLUMN `cache_miss_input_tokens` integer;
--> statement-breakpoint
ALTER TABLE `run_budget_entries` ADD COLUMN `cache_write_input_tokens` integer;
--> statement-breakpoint
ALTER TABLE `run_budget_entries` ADD COLUMN `reasoning_tokens` integer;
--> statement-breakpoint
ALTER TABLE `run_budget_entries` ADD COLUMN `provider_call_id` text;
--> statement-breakpoint
ALTER TABLE `run_budget_entries` ADD COLUMN `cache_epoch_id` text;
--> statement-breakpoint
ALTER TABLE `run_budget_entries` ADD COLUMN `continuity_group` text;
--> statement-breakpoint
ALTER TABLE `run_budget_entries` ADD COLUMN `prefix_fingerprint` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `run_budget_entries_provider_call_unique`
  ON `run_budget_entries` (`provider_call_id`);
