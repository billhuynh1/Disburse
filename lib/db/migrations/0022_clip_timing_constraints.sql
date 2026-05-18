ALTER TABLE "clip_candidates"
  ADD CONSTRAINT "clip_candidates_valid_timing_chk"
  CHECK (
    "start_time_ms" >= 0
    AND "end_time_ms" > "start_time_ms"
    AND "duration_ms" = "end_time_ms" - "start_time_ms"
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "clip_candidate_facecam_detections"
  ADD CONSTRAINT "clip_candidate_facecam_detections_valid_timing_chk"
  CHECK (
    "start_time_ms" >= 0
    AND "end_time_ms" > "start_time_ms"
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "rendered_clips"
  ADD CONSTRAINT "rendered_clips_valid_timing_chk"
  CHECK (
    "start_time_ms" >= 0
    AND "end_time_ms" > "start_time_ms"
    AND "duration_ms" = "end_time_ms" - "start_time_ms"
  ) NOT VALID;
