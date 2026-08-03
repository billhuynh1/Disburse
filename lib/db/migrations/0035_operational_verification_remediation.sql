ALTER TABLE "pipeline_scheduler_state" ADD COLUMN "reconciliation_progress_at" timestamp;--> statement-breakpoint
ALTER TABLE "pipeline_scheduler_state" ADD COLUMN "reconciliation_progress_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE "operational_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_type" varchar(40) NOT NULL,
	"provider" varchar(20),
	"failure_class" varchar(30),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operational_signals_type_check" CHECK ("operational_signals"."signal_type" in ('internal_trigger_failure', 'provider_failure', 'capacity_blocked', 'unknown_failure')),
	CONSTRAINT "operational_signals_provider_check" CHECK ("operational_signals"."provider" is null or "operational_signals"."provider" in ('openai', 's3', 'media', 'render', 'facecam')),
	CONSTRAINT "operational_signals_failure_class_check" CHECK ("operational_signals"."failure_class" is null or "operational_signals"."failure_class" in ('transient', 'safe_retry', 'permanent', 'ambiguous_external_effect', 'cancellation', 'unknown'))
);--> statement-breakpoint
CREATE INDEX "operational_signals_type_created_idx" ON "operational_signals" USING btree ("signal_type","created_at");
