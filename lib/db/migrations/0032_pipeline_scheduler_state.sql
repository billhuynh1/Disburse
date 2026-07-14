CREATE TABLE "pipeline_scheduler_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner_token" text,
	"lease_expires_at" timestamp,
	"heartbeat_at" timestamp,
	"reconciliation_cursor" integer,
	"reconciliation_cycle" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_scheduler_state_singleton_check" CHECK ("pipeline_scheduler_state"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "pipeline_scheduler_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
