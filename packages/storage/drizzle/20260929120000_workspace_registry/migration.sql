CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_path` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`last_opened_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_canonical_path_unique` ON `workspaces` (`canonical_path`);
--> statement-breakpoint
CREATE INDEX `workspaces_last_opened_at_idx` ON `workspaces` (`last_opened_at_ms`);
