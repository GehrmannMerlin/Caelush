CREATE TABLE `provider_invocation_usage` (
  `call_id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `agent_runs` (`id`) ON DELETE CASCADE,
  `purpose` text NOT NULL,
  `status` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `api` text NOT NULL,
  `continuity_group` text NOT NULL,
  `cache_epoch_id` text,
  `prefix_fingerprint` text,
  `request_fingerprint` text NOT NULL,
  `observed_at_ms` integer NOT NULL,
  `settled_at_ms` integer,
  `total_tokens` integer,
  `input_tokens` integer,
  `output_tokens` integer,
  `cache_hit_input_tokens` integer,
  `cache_miss_input_tokens` integer,
  `cache_write_input_tokens` integer,
  `reasoning_tokens` integer
);
--> statement-breakpoint
CREATE INDEX `provider_invocation_usage_run_order_idx`
  ON `provider_invocation_usage` (`run_id`, `observed_at_ms`, `call_id`);
--> statement-breakpoint
CREATE INDEX `provider_invocation_usage_purpose_idx`
  ON `provider_invocation_usage` (`run_id`, `purpose`);
