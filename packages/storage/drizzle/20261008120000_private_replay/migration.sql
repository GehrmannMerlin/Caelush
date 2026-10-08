CREATE TABLE `private_replays` (
  `message_id` text PRIMARY KEY NOT NULL REFERENCES `agent_messages` (`message_id`) ON DELETE CASCADE,
  `run_id` text NOT NULL REFERENCES `agent_runs` (`id`) ON DELETE CASCADE,
  `session_id` text NOT NULL REFERENCES `agent_sessions` (`id`) ON DELETE CASCADE,
  `identity_json` text NOT NULL,
  `envelope_json` text NOT NULL,
  `key_id` text NOT NULL,
  `nonce` text NOT NULL,
  UNIQUE (`key_id`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `private_replays_run_idx` ON `private_replays` (`run_id`);
