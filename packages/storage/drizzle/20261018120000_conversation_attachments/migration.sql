CREATE TABLE attachments (
  artifact_id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('WORKSPACE', 'SESSION')),
  owner_id text NOT NULL,
  name text NOT NULL,
  declared_media_type text NOT NULL,
  media_type text,
  byte_length integer CHECK (byte_length IS NULL OR (byte_length >= 0 AND byte_length <= 26214400)),
  sha256 text CHECK (sha256 IS NULL OR length(sha256) = 64),
  status text NOT NULL CHECK (status IN ('UPLOADING', 'PREPROCESSING', 'READY', 'FAILED', 'UNAVAILABLE')),
  visual_requirement text NOT NULL CHECK (visual_requirement IN ('NOT_REQUIRED', 'POSSIBLE', 'REQUIRED', 'UNKNOWN')),
  processor_version text,
  created_at_ms integer NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms integer NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (owner_kind <> 'WORKSPACE' OR owner_id = workspace_id),
  CHECK (status <> 'READY' OR (media_type IS NOT NULL AND byte_length IS NOT NULL AND sha256 IS NOT NULL AND processor_version IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX attachments_workspace_created_idx ON attachments(workspace_id, created_at_ms);
--> statement-breakpoint
CREATE INDEX attachments_owner_idx ON attachments(owner_kind, owner_id);
--> statement-breakpoint
CREATE INDEX attachments_status_created_idx ON attachments(status, created_at_ms);
--> statement-breakpoint
CREATE TABLE attachment_drafts (
  owner_kind text NOT NULL CHECK (owner_kind IN ('WORKSPACE', 'SESSION')),
  owner_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  text text NOT NULL,
  submission_id text,
  updated_at_ms integer NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (owner_kind, owner_id)
);
--> statement-breakpoint
CREATE TABLE attachment_references (
  artifact_id text NOT NULL REFERENCES attachments(artifact_id) ON DELETE CASCADE,
  reference_kind text NOT NULL CHECK (reference_kind IN ('DRAFT', 'MESSAGE')),
  reference_id text NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('WORKSPACE', 'SESSION')),
  owner_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at_ms integer NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (artifact_id, reference_kind, reference_id)
);
--> statement-breakpoint
CREATE INDEX attachment_references_target_idx ON attachment_references(reference_kind, owner_kind, owner_id);
--> statement-breakpoint
CREATE TABLE submissions (
  submission_id text PRIMARY KEY NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at_ms integer NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms integer NOT NULL CHECK (updated_at_ms >= 0)
);
--> statement-breakpoint
CREATE INDEX submissions_session_id_idx ON submissions(session_id);
--> statement-breakpoint
CREATE INDEX submissions_run_id_idx ON submissions(run_id);
