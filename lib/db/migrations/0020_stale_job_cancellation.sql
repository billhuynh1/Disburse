ALTER TABLE "clip_candidate_facecam_detections"
ADD COLUMN "generation_run_id" text;

UPDATE "clip_candidate_facecam_detections"
SET "generation_run_id" = "clip_candidates"."generation_run_id"
FROM "clip_candidates"
WHERE "clip_candidate_facecam_detections"."clip_candidate_id" = "clip_candidates"."id"
  AND "clip_candidate_facecam_detections"."generation_run_id" IS NULL;

ALTER TABLE "clip_candidate_facecam_detections"
ALTER COLUMN "generation_run_id" SET NOT NULL;

CREATE INDEX "clip_candidate_facecam_detections_candidate_generation_run_idx"
ON "clip_candidate_facecam_detections" USING btree ("clip_candidate_id", "generation_run_id");
