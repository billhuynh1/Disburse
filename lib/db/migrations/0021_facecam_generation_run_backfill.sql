ALTER TABLE "clip_candidate_facecam_detections"
ADD COLUMN IF NOT EXISTS "generation_run_id" text;

UPDATE "clip_candidate_facecam_detections"
SET "generation_run_id" = "clip_candidates"."generation_run_id"
FROM "clip_candidates"
WHERE "clip_candidate_facecam_detections"."clip_candidate_id" = "clip_candidates"."id"
  AND "clip_candidate_facecam_detections"."generation_run_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "clip_candidate_facecam_detections"
    WHERE "generation_run_id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce clip_candidate_facecam_detections.generation_run_id NOT NULL because some rows could not be backfilled';
  END IF;
END $$;

ALTER TABLE "clip_candidate_facecam_detections"
ALTER COLUMN "generation_run_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "clip_candidate_facecam_detections_candidate_generation_run_idx"
ON "clip_candidate_facecam_detections" USING btree ("clip_candidate_id", "generation_run_id");
