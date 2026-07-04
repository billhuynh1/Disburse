CREATE TABLE "clip_candidate_facecam_detection_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source_asset_id" integer NOT NULL,
	"content_pack_id" integer NOT NULL,
	"clip_candidate_id" integer NOT NULL,
	"generation_run_id" text NOT NULL,
	"detector_version" text DEFAULT 'facecam_v1' NOT NULL,
	"start_time_ms" integer NOT NULL,
	"end_time_ms" integer NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"debug_reason" text,
	"sampled_frame_count" integer,
	"detection_stage" text,
	"debug_summary" text,
	"job_id" integer,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detection_runs" ADD CONSTRAINT "clip_candidate_facecam_detection_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detection_runs" ADD CONSTRAINT "clip_candidate_facecam_detection_runs_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detection_runs" ADD CONSTRAINT "clip_candidate_facecam_detection_runs_content_pack_id_content_packs_id_fk" FOREIGN KEY ("content_pack_id") REFERENCES "public"."content_packs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detection_runs" ADD CONSTRAINT "clip_candidate_facecam_detection_runs_clip_candidate_id_clip_candidates_id_fk" FOREIGN KEY ("clip_candidate_id") REFERENCES "public"."clip_candidates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detection_runs" ADD CONSTRAINT "clip_candidate_facecam_detection_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "clip_candidate_facecam_detection_runs_key_idx" ON "clip_candidate_facecam_detection_runs" USING btree ("source_asset_id","clip_candidate_id","generation_run_id","start_time_ms","end_time_ms","detector_version");
--> statement-breakpoint
CREATE INDEX "clip_candidate_facecam_detection_runs_candidate_status_idx" ON "clip_candidate_facecam_detection_runs" USING btree ("clip_candidate_id","status");
--> statement-breakpoint
CREATE INDEX "clip_candidate_facecam_detection_runs_source_asset_idx" ON "clip_candidate_facecam_detection_runs" USING btree ("source_asset_id");
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detections" ADD COLUMN "detection_run_id" integer;
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detections" ADD COLUMN "detector_version" text DEFAULT 'facecam_v1' NOT NULL;
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detections" ADD CONSTRAINT "clip_candidate_facecam_detections_detection_run_id_clip_candidate_facecam_detection_runs_id_fk" FOREIGN KEY ("detection_run_id") REFERENCES "public"."clip_candidate_facecam_detection_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "clip_candidate_facecam_detections_candidate_rank_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "clip_candidate_facecam_detections_run_rank_idx" ON "clip_candidate_facecam_detections" USING btree ("detection_run_id","rank");
