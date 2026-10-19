-- Durable mid-Run user text intake.
--
-- `run_input_heads` is the per-Run FIFO allocator. It is its own row so an intake transaction can
-- allocate the next sequence with a single UPDATE and without scanning the inputs.
--
-- `run_inputs` is the staging record and the handoff ledger. It is not a conversation authority:
-- once an input is RECORDED, the canonical `agent_messages` row is the only text, and the staging
-- text is cleared. The hash and byte length survive for idempotent comparison.
CREATE TABLE run_input_heads (
  run_id text PRIMARY KEY NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  last_accepted_sequence integer NOT NULL CHECK (last_accepted_sequence >= 0)
);
--> statement-breakpoint
CREATE TABLE run_inputs (
  input_id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  accepted_sequence integer NOT NULL CHECK (accepted_sequence >= 1),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  stage text NOT NULL CHECK (stage IN ('PENDING', 'RECORDED', 'ASSIGNED')),
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 32768),
  staged_text text,
  message_id text REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  first_step_id text REFERENCES agent_steps(id) ON DELETE CASCADE,
  accepted_at_ms integer NOT NULL CHECK (accepted_at_ms >= 0),
  recorded_at_ms integer CHECK (recorded_at_ms IS NULL OR recorded_at_ms >= 0),
  assigned_at_ms integer CHECK (assigned_at_ms IS NULL OR assigned_at_ms >= 0),
  UNIQUE (run_id, accepted_sequence),
  -- One canonical message answers exactly one input. SQLite allows repeated NULLs here, which is
  -- what a PENDING row is.
  UNIQUE (message_id),
  CHECK (
    (stage = 'PENDING' AND staged_text IS NOT NULL AND message_id IS NULL AND first_step_id IS NULL)
    OR (stage = 'RECORDED' AND staged_text IS NULL AND message_id IS NOT NULL AND first_step_id IS NULL)
    OR (stage = 'ASSIGNED' AND staged_text IS NULL AND message_id IS NOT NULL AND first_step_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX run_inputs_run_stage_sequence_idx ON run_inputs(run_id, stage, accepted_sequence);
--> statement-breakpoint
CREATE INDEX run_inputs_message_idx ON run_inputs(message_id);
