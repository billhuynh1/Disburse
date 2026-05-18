ALTER TABLE "jobs" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE TABLE "facecam_segments" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "video_id" integer NOT NULL,
  "source_asset_id" integer NOT NULL,
  "rank" integer NOT NULL,
  "start_time_ms" integer NOT NULL,
  "end_time_ms" integer NOT NULL,
  "frame_width" integer NOT NULL,
  "frame_height" integer NOT NULL,
  "x_px" integer NOT NULL,
  "y_px" integer NOT NULL,
  "width_px" integer NOT NULL,
  "height_px" integer NOT NULL,
  "confidence" integer NOT NULL,
  "layout_type" varchar(40) NOT NULL,
  "sampled_frame_count" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facecam_segments" ADD CONSTRAINT "facecam_segments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facecam_segments" ADD CONSTRAINT "facecam_segments_video_id_source_assets_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facecam_segments" ADD CONSTRAINT "facecam_segments_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "facecam_segments_video_timing_idx" ON "facecam_segments" USING btree ("video_id","start_time_ms","end_time_ms");
--> statement-breakpoint
CREATE INDEX "facecam_segments_video_rank_idx" ON "facecam_segments" USING btree ("video_id","rank");
