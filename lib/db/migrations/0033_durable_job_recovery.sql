CREATE TABLE "job_effect_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"effect_key" text NOT NULL,
	"job_type" varchar(50) NOT NULL,
	"status" varchar(30) NOT NULL,
	"result" jsonb,
	"external_effect_started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_recovery_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_identity" text NOT NULL,
	"requested_job_id" integer,
	"event_type" varchar(30) NOT NULL,
	"outcome_code" varchar(80) NOT NULL,
	"safe_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_recovery_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_identity" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"requested_user_id" integer,
	"requested_job_id" integer,
	"requested_mode" varchar(30),
	"expected_current_generation" text,
	"outcome" varchar(20) NOT NULL,
	"outcome_code" varchar(80) NOT NULL,
	"successor_job_id" integer,
	"safe_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure_code" varchar(80);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure_class" varchar(40);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "logical_job_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "root_job_id" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "parent_job_id" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "recovery_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "recovery_mode" varchar(30);--> statement-breakpoint
ALTER TABLE "job_effect_checkpoints" ADD CONSTRAINT "job_effect_checkpoints_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_recovery_requests" ADD CONSTRAINT "job_recovery_requests_successor_job_id_jobs_id_fk" FOREIGN KEY ("successor_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_effect_checkpoints_job_effect_idx" ON "job_effect_checkpoints" USING btree ("job_id","effect_key");--> statement-breakpoint
CREATE INDEX "job_effect_checkpoints_status_idx" ON "job_effect_checkpoints" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_recovery_events_request_idx" ON "job_recovery_events" USING btree ("request_identity","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_recovery_requests_identity_idx" ON "job_recovery_requests" USING btree ("idempotency_identity");--> statement-breakpoint
CREATE INDEX "job_recovery_requests_requested_job_idx" ON "job_recovery_requests" USING btree ("requested_job_id","created_at");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_root_job_id_jobs_id_fk" FOREIGN KEY ("root_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_logical_job_idx" ON "jobs" USING btree ("logical_job_key") WHERE "jobs"."logical_job_key" is not null and "jobs"."status" in ('pending', 'processing');