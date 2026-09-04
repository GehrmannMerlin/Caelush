CREATE TABLE `context_runtime_states` (
  `run_id` text PRIMARY KEY NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `profile_source` text NOT NULL,
  `context_window_tokens` integer NOT NULL,
  `effective_input_limit_tokens` integer NOT NULL,
  `estimated_input_tokens` integer NOT NULL,
  `remaining_tokens` integer NOT NULL,
  `pressure_state` text NOT NULL,
  `compaction_count` integer NOT NULL,
  `last_compaction_at_ms` integer,
  `breakdown_json` text NOT NULL,
  `last_build_status` text NOT NULL,
  `updated_at_ms` integer NOT NULL,
  CONSTRAINT `fk_context_runtime_states_run_id_agent_runs_id` FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
