DROP INDEX "rendered_clips_candidate_variant_idx";--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "layout" varchar(40) DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rendered_clips_candidate_variant_layout_idx" ON "rendered_clips" USING btree ("clip_candidate_id","variant","layout");
