ALTER TABLE `provider_invocation_usage` ADD COLUMN `step_id` text;
--> statement-breakpoint
CREATE INDEX `provider_invocation_usage_run_step_order_idx`
  ON `provider_invocation_usage` (`run_id`, `step_id`, `observed_at_ms`, `call_id`);
