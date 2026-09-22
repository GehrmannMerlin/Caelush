-- Phase 5B — Message System V2 durable storage foundation (transitional, Stage A/B).
--
-- This migration makes `agent_messages` able to hold a versioned Message V2 record while the
-- pre-V2 production writer keeps running unchanged. It is deliberately ADDITIVE and deliberately
-- nullable: the legacy Run execution writer knows nothing about the new columns and must keep
-- working until Phase 5C cuts it over.
--
-- ---------------------------------------------------------------------------------------------
-- Two encodings, one row, one authority each
-- ---------------------------------------------------------------------------------------------
--
--   data_json      the legacy LLMMessage JSON       read by the legacy reader   until Phase 5F
--   v2_data_json   AgentMessageRecord.data          read by the V2 record store until Stage C
--
-- A row is legacy-only (v2_data_json IS NULL) or V2-backed (v2_data_json IS NOT NULL). It is never
-- both, so neither encoding can be misread as the other, and there is never a second mutable
-- semantic truth for one message.
--
-- Phase 5F's Stage C rebuild moves the V2 payload into `data_json`, drops the legacy columns and
-- promotes `message_id` to the primary key. None of that happens here.
--
-- ---------------------------------------------------------------------------------------------
-- Why every V2 column is nullable
-- ---------------------------------------------------------------------------------------------
--
-- The legacy writer does not populate them. A NOT NULL constraint would crash the current
-- production path the moment it appended a message, and the legacy reader would fail the same way.
-- Nullability is therefore not laxity; it is the compatibility surface this stage exists to provide.
--
-- ---------------------------------------------------------------------------------------------
-- Why `conversation_turns` is NOT created
-- ---------------------------------------------------------------------------------------------
--
-- A turn is derived from Run metadata plus message records. Materialising it would create a second
-- authority over which messages belong to a turn, and the two could disagree.
--
-- ---------------------------------------------------------------------------------------------

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

ALTER TABLE `agent_messages` ADD COLUMN `message_id` text;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD COLUMN `session_id` text;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD COLUMN `conversation_turn_id` text;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD COLUMN `message_type` text;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD COLUMN `schema_version` integer;
--> statement-breakpoint
-- Absent for a legacy row, and also absent for a V2 message whose `audience.model` is false: such a
-- message has no model view, so recording a projector version would claim a projection that never
-- happens. The V2 store enforces the presence rule structurally rather than via NOT NULL.
ALTER TABLE `agent_messages` ADD COLUMN `model_projection_version` integer;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD COLUMN `source_json` text;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD COLUMN `audience_json` text;
--> statement-breakpoint
-- The AgentMessageRecord.data payload. Named `v2_data_json` so it can never be confused with the
-- legacy `data_json` that the current production reader still depends on.
ALTER TABLE `agent_messages` ADD COLUMN `v2_data_json` text;
--> statement-breakpoint

-- Uniqueness is partial on purpose. `message_id` is NULL for every legacy-only row, and a plain
-- UNIQUE index would reject the second and every later NULL row. The partial index enforces the real
-- rule: an identity, when present, is unique.
CREATE UNIQUE INDEX `agent_messages_message_id_unique`
  ON `agent_messages` (`message_id`)
  WHERE `message_id` IS NOT NULL;
--> statement-breakpoint

-- Session reads. `listBySession` is the read the conversation repository's snapshot load needs, and
-- without this index it would scan the table for every transcript or context build.
CREATE INDEX `agent_messages_session_sequence_idx`
  ON `agent_messages` (`session_id`, `run_id`, `sequence`);
--> statement-breakpoint

-- Turn grouping.
CREATE INDEX `agent_messages_conversation_turn_idx`
  ON `agent_messages` (`conversation_turn_id`);
--> statement-breakpoint

-- Message type lookup, for a backfill sweep and for a future typed read.
CREATE INDEX `agent_messages_message_type_idx`
  ON `agent_messages` (`message_type`);
--> statement-breakpoint

-- `run_id + sequence` already has both a UNIQUE index and a non-unique one from the original
-- `durable_runtime` migration. They are left exactly as they were: this migration adds a substrate,
-- it does not redefine the ordering authority that already exists.
PRAGMA foreign_keys=ON;
