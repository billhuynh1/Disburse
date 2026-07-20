CREATE TABLE "operational_invocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"invocation_id" varchar(36) NOT NULL,
	"origin" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"stop_reason" varchar(40),
	"failure_class" varchar(30),
	"failure_code" varchar(80),
	"processed_jobs" integer DEFAULT 0 NOT NULL,
	"recovered_jobs" integer DEFAULT 0 NOT NULL,
	"reconciled_projects" integer DEFAULT 0 NOT NULL,
	"reconciliation_cycle" bigint,
	"follow_up_triggered" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operational_invocations_origin_check" CHECK ("operational_invocations"."origin" in ('internal', 'cron')),
	CONSTRAINT "operational_invocations_status_check" CHECK ("operational_invocations"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "operational_invocations_counts_check" CHECK ("operational_invocations"."processed_jobs" >= 0 and "operational_invocations"."recovered_jobs" >= 0 and "operational_invocations"."reconciled_projects" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operational_invocations_invocation_id_idx" ON "operational_invocations" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "operational_invocations_origin_started_idx" ON "operational_invocations" USING btree ("origin","started_at");--> statement-breakpoint
CREATE INDEX "operational_invocations_status_started_idx" ON "operational_invocations" USING btree ("status","started_at");