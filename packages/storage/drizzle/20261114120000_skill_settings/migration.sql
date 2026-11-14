CREATE TABLE `skill_settings` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`model_invocable` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `skill_settings_enabled_check` CHECK (`enabled` IN (0, 1)),
	CONSTRAINT `skill_settings_model_invocable_check` CHECK (`model_invocable` IS NULL OR `model_invocable` IN (0, 1)),
	CONSTRAINT `skill_settings_version_check` CHECK (`version` >= 0)
);
