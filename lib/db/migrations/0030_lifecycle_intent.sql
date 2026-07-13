ALTER TABLE "projects" ADD COLUMN "deletion_requested_at" timestamp;
--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "deletion_requested_at" timestamp;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cancellation_reason" varchar(40);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cancellation_requested_at" timestamp;
