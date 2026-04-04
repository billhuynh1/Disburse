CREATE TABLE "clip_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"content_pack_id" integer NOT NULL,
	"source_asset_id" integer NOT NULL,
	"transcript_id" integer NOT NULL,
	"rank" integer NOT NULL,
	"start_time_ms" integer NOT NULL,
	"end_time_ms" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"hook" text NOT NULL,
	"title" varchar(150) NOT NULL,
	"caption_copy" text NOT NULL,
	"summary" text NOT NULL,
	"transcript_excerpt" text NOT NULL,
	"why_it_works" text NOT NULL,
	"platform_fit" text NOT NULL,
	"confidence" integer NOT NULL,
	"review_status" varchar(30) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"transcript_id" integer NOT NULL,
	"sequence" integer NOT NULL,
	"start_time_ms" integer NOT NULL,
	"end_time_ms" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_packs" ADD COLUMN "kind" varchar(50) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_content_pack_id_content_packs_id_fk" FOREIGN KEY ("content_pack_id") REFERENCES "public"."content_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_candidates_content_pack_rank_idx" ON "clip_candidates" USING btree ("content_pack_id","rank");--> statement-breakpoint
CREATE INDEX "clip_candidates_source_asset_idx" ON "clip_candidates" USING btree ("source_asset_id");--> statement-breakpoint
CREATE INDEX "transcript_segments_transcript_sequence_idx" ON "transcript_segments" USING btree ("transcript_id","sequence");--> statement-breakpoint
CREATE INDEX "transcript_segments_transcript_timing_idx" ON "transcript_segments" USING btree ("transcript_id","start_time_ms");