DROP INDEX IF EXISTS "jobs_idempotency_key_idx";
--> statement-breakpoint
WITH classified AS (
  SELECT
    "id",
    "status",
    coalesce(CASE "type"
      WHEN 'transcribe_source_asset' THEN
        'transcribe_source_asset:source:' || ("payload"->>'sourceAssetId') || ':v1'
      WHEN 'extract_source_asset_thumbnail' THEN
        'source-asset-thumbnail:' || ("payload"->>'sourceAssetId')
      WHEN 'ingest_youtube_source_asset' THEN
        'ingest_youtube_source_asset:source:' || ("payload"->>'sourceAssetId') || ':v1'
      WHEN 'generate_short_form_pack' THEN
        'generate-short-form:pack:' || ("payload"->>'contentPackId') || ':run:' || coalesce("payload"->>'generationRunId', 'legacy')
      WHEN 'render_clip_candidate' THEN
        'render_clip_candidate:candidate:' || ("payload"->>'clipCandidateId') || ':run:' || coalesce("payload"->>'generationRunId', 'legacy') || ':variant:trimmed_original:layout:default:config:default'
      WHEN 'format_rendered_clip_short_form' THEN
        'format_rendered_clip_short_form:candidate:' || ("payload"->>'clipCandidateId') || ':run:' || coalesce("payload"->>'generationRunId', 'legacy') || ':variant:' || coalesce("payload"->>'variant', 'vertical_short_form') || ':layout:' || coalesce("payload"->>'layout', 'default') || ':config:' || coalesce("payload"->>'editConfigHash', 'default')
      WHEN 'detect_clip_facecam' THEN coalesce(
        "idempotency_key",
        'facecam:' || ("payload"->>'sourceAssetId') || ':candidate:' || coalesce("payload"->>'clipCandidateId', 'legacy') || ':range:' || coalesce("payload"->>'startTimeMs', '0') || '-' || coalesce("payload"->>'endTimeMs', '0') || ':detector:' || coalesce("payload"->>'detectorVersion', 'facecam_v1')
      )
      WHEN 'publish_rendered_clip' THEN
        'publish:publication:' || ("payload"->>'clipPublicationId') || ':rendered:' || ("payload"->>'renderedClipId')
      ELSE 'legacy-job:' || "id"::text
    END, 'legacy-job:' || "id"::text) AS desired_key
  FROM "jobs"
), ranked AS (
  SELECT
    *,
    row_number() OVER (
      PARTITION BY desired_key
      ORDER BY
        CASE WHEN "status" IN ('pending', 'processing') THEN 0 ELSE 1 END,
        "id"
    ) AS duplicate_rank
  FROM classified
)
UPDATE "jobs" AS target
SET
  "idempotency_key" = CASE
    WHEN ranked.duplicate_rank = 1 THEN ranked.desired_key
    ELSE ranked.desired_key || ':duplicate:' || ranked."id"::text
  END,
  "status" = CASE
    WHEN ranked.duplicate_rank > 1 AND ranked."status" IN ('pending', 'processing')
      THEN 'cancelled'
    ELSE ranked."status"
  END,
  "failure_reason" = CASE
    WHEN ranked.duplicate_rank > 1 AND ranked."status" IN ('pending', 'processing')
      THEN 'Cancelled by durable job identity migration as a duplicate.'
    ELSE target."failure_reason"
  END,
  "completed_at" = CASE
    WHEN ranked.duplicate_rank > 1 AND ranked."status" IN ('pending', 'processing')
      THEN now()
    ELSE target."completed_at"
  END
FROM ranked
WHERE target."id" = ranked."id";
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "idempotency_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_token" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp;
--> statement-breakpoint
UPDATE "jobs"
SET "lease_expires_at" = now()
WHERE "status" = 'processing';
--> statement-breakpoint
CREATE INDEX "jobs_lease_expiry_idx" ON "jobs" USING btree ("status", "lease_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs" USING btree ("idempotency_key");
