CREATE TABLE "clip_candidate_facecam_detections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source_asset_id" integer NOT NULL,
	"clip_candidate_id" integer NOT NULL,
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
	"sampled_frame_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD COLUMN "facecam_detection_status" varchar(20) DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD COLUMN "facecam_detection_failure_reason" text;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD COLUMN "facecam_detected_at" timestamp;--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detections" ADD CONSTRAINT "clip_candidate_facecam_detections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detections" ADD CONSTRAINT "clip_candidate_facecam_detections_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detections" ADD CONSTRAINT "clip_candidate_facecam_detections_clip_candidate_id_clip_candidates_id_fk" FOREIGN KEY ("clip_candidate_id") REFERENCES "public"."clip_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_candidate_facecam_detections_candidate_idx" ON "clip_candidate_facecam_detections" USING btree ("clip_candidate_id");--> statement-breakpoint
CREATE INDEX "clip_candidate_facecam_detections_source_asset_idx" ON "clip_candidate_facecam_detections" USING btree ("source_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_candidate_facecam_detections_candidate_rank_idx" ON "clip_candidate_facecam_detections" USING btree ("clip_candidate_id","rank");