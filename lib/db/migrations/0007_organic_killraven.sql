ALTER TABLE "rendered_clips" DROP CONSTRAINT "rendered_clips_clip_candidate_id_unique";--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "variant" varchar(40) DEFAULT 'trimmed_original' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rendered_clips_candidate_variant_idx" ON "rendered_clips" USING btree ("clip_candidate_id","variant");