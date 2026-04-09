CREATE TABLE "rendered_clips" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"content_pack_id" integer NOT NULL,
	"source_asset_id" integer NOT NULL,
	"clip_candidate_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"title" varchar(150) NOT NULL,
	"start_time_ms" integer NOT NULL,
	"end_time_ms" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"storage_key" text,
	"storage_url" text,
	"mime_type" varchar(100),
	"file_size_bytes" integer,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "rendered_clips_clip_candidate_id_unique" UNIQUE("clip_candidate_id"),
	CONSTRAINT "rendered_clips_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD CONSTRAINT "rendered_clips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD CONSTRAINT "rendered_clips_content_pack_id_content_packs_id_fk" FOREIGN KEY ("content_pack_id") REFERENCES "public"."content_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD CONSTRAINT "rendered_clips_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD CONSTRAINT "rendered_clips_clip_candidate_id_clip_candidates_id_fk" FOREIGN KEY ("clip_candidate_id") REFERENCES "public"."clip_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rendered_clips_content_pack_idx" ON "rendered_clips" USING btree ("content_pack_id");--> statement-breakpoint
CREATE INDEX "rendered_clips_source_asset_idx" ON "rendered_clips" USING btree ("source_asset_id");--> statement-breakpoint
CREATE INDEX "rendered_clips_status_idx" ON "rendered_clips" USING btree ("status","updated_at");