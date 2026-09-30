CREATE TABLE `ai_provider_credentials` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`secret_value` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_default_selections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`reasoning_level` text,
	`updated_at_ms` integer NOT NULL
);
