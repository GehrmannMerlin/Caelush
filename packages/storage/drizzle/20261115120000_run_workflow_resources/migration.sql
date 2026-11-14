CREATE TABLE "run_workflow_profiles" (
	"run_id" text PRIMARY KEY NOT NULL,
	"profile_version" integer NOT NULL,
	"data_json" text NOT NULL,
	CONSTRAINT "fk_run_workflow_profiles_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id"),
	CONSTRAINT "run_workflow_profiles_version_check" CHECK ("profile_version" = 1)
);
--> statement-breakpoint
CREATE TABLE "run_prepared_resources" (
	"binding_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_revision" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"utf8_bytes" integer NOT NULL,
	"token_estimate" integer NOT NULL,
	"source_tool_invocation_id" text,
	"activation_ordinal" integer NOT NULL,
	"data_json" text NOT NULL,
	CONSTRAINT "fk_run_prepared_resources_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id"),
	CONSTRAINT "run_prepared_resources_kind_check" CHECK ("resource_kind" = 'WORKFLOW_INSTRUCTION'),
	CONSTRAINT "run_prepared_resources_utf8_bytes_check" CHECK ("utf8_bytes" >= 0),
	CONSTRAINT "run_prepared_resources_token_estimate_check" CHECK ("token_estimate" >= 0),
	CONSTRAINT "run_prepared_resources_activation_ordinal_check" CHECK ("activation_ordinal" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "run_prepared_resources_version_unique" ON "run_prepared_resources" ("run_id","resource_id","resource_revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "run_prepared_resources_activation_unique" ON "run_prepared_resources" ("run_id","activation_ordinal");
--> statement-breakpoint
CREATE INDEX "run_prepared_resources_run_order_idx" ON "run_prepared_resources" ("run_id","activation_ordinal");
