CREATE TABLE session_archives (
  session_id text PRIMARY KEY NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  archive_id text NOT NULL UNIQUE,
  archived_at_ms integer CHECK (archived_at_ms IS NULL OR archived_at_ms >= 0),
  reason text NOT NULL CHECK (reason IN ('USER', 'LEGACY_SESSION_MARKER', 'LEGACY_FORGOTTEN_WORKSPACE'))
);
--> statement-breakpoint
CREATE TABLE workspace_archives (
  workspace_id text PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  archive_id text NOT NULL UNIQUE,
  archived_at_ms integer CHECK (archived_at_ms IS NULL OR archived_at_ms >= 0),
  reason text NOT NULL CHECK (reason IN ('USER', 'LEGACY_SESSION_MARKER', 'LEGACY_FORGOTTEN_WORKSPACE'))
);
--> statement-breakpoint
CREATE TABLE archive_catalog_meta (
  singleton integer PRIMARY KEY NOT NULL CHECK (singleton = 1),
  revision integer NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991)
);
--> statement-breakpoint
INSERT INTO archive_catalog_meta (singleton, revision) VALUES (1, 0);
