ALTER TABLE "projects" ADD COLUMN "is_saved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
UPDATE "projects"
SET
  "is_saved" = "saved_at" IS NOT NULL,
  "expires_at" = CASE
    WHEN "saved_at" IS NOT NULL THEN NULL
    ELSE "created_at" + interval '7 days'
  END;--> statement-breakpoint
UPDATE "source_assets"
SET "expires_at" = "projects"."expires_at"
FROM "projects"
WHERE
  "source_assets"."project_id" = "projects"."id"
  AND "source_assets"."retention_status" = 'temporary'
  AND "projects"."expires_at" IS NOT NULL;--> statement-breakpoint
UPDATE "rendered_clips"
SET "expires_at" = "projects"."expires_at"
FROM "content_packs"
INNER JOIN "projects" ON "content_packs"."project_id" = "projects"."id"
WHERE
  "rendered_clips"."content_pack_id" = "content_packs"."id"
  AND "rendered_clips"."retention_status" = 'temporary'
  AND "projects"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_temporary_expiry_idx" ON "projects" USING btree ("is_saved","expires_at");
