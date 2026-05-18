ALTER TABLE "content_packs" ADD COLUMN "generation_run_id" text;
ALTER TABLE "clip_candidates" ADD COLUMN "generation_run_id" text;
ALTER TABLE "clip_edit_configs" ADD COLUMN "generation_run_id" text;
ALTER TABLE "rendered_clips" ADD COLUMN "generation_run_id" text;

UPDATE "content_packs"
SET "generation_run_id" = md5(random()::text || clock_timestamp()::text || "id"::text)
WHERE "generation_run_id" IS NULL;

UPDATE "clip_candidates"
SET "generation_run_id" = "content_packs"."generation_run_id"
FROM "content_packs"
WHERE "clip_candidates"."content_pack_id" = "content_packs"."id"
  AND "clip_candidates"."generation_run_id" IS NULL;

UPDATE "clip_edit_configs"
SET "generation_run_id" = "content_packs"."generation_run_id"
FROM "content_packs"
WHERE "clip_edit_configs"."content_pack_id" = "content_packs"."id"
  AND "clip_edit_configs"."generation_run_id" IS NULL;

UPDATE "rendered_clips"
SET "generation_run_id" = "content_packs"."generation_run_id"
FROM "content_packs"
WHERE "rendered_clips"."content_pack_id" = "content_packs"."id"
  AND "rendered_clips"."generation_run_id" IS NULL;

ALTER TABLE "content_packs" ALTER COLUMN "generation_run_id" SET NOT NULL;
ALTER TABLE "clip_candidates" ALTER COLUMN "generation_run_id" SET NOT NULL;
ALTER TABLE "clip_edit_configs" ALTER COLUMN "generation_run_id" SET NOT NULL;
ALTER TABLE "rendered_clips" ALTER COLUMN "generation_run_id" SET NOT NULL;

CREATE INDEX "content_packs_generation_run_idx" ON "content_packs" USING btree ("generation_run_id");
CREATE INDEX "clip_candidates_pack_generation_run_idx" ON "clip_candidates" USING btree ("content_pack_id","generation_run_id");
CREATE INDEX "clip_edit_configs_candidate_generation_run_idx" ON "clip_edit_configs" USING btree ("clip_candidate_id","generation_run_id");
CREATE INDEX "rendered_clips_candidate_generation_run_idx" ON "rendered_clips" USING btree ("clip_candidate_id","generation_run_id");
