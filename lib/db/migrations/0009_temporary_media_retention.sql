ALTER TABLE "users" ADD COLUMN "storage_limit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_save_approved_clips_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "saved_at" timestamp;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "retention_status" varchar(20);--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "saved_at" timestamp;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "storage_deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "retention_status" varchar(20);--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "saved_at" timestamp;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "storage_deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
CREATE INDEX "source_assets_retention_expiry_idx" ON "source_assets" USING btree ("retention_status","expires_at");--> statement-breakpoint
CREATE INDEX "rendered_clips_retention_expiry_idx" ON "rendered_clips" USING btree ("retention_status","expires_at");
