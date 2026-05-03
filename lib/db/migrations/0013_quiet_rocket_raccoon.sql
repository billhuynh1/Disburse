ALTER TABLE "source_assets" ADD COLUMN "thumbnail_storage_key" text;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "thumbnail_mime_type" varchar(100);--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "thumbnail_width" integer;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "thumbnail_height" integer;--> statement-breakpoint
ALTER TABLE "source_assets" ADD CONSTRAINT "source_assets_thumbnail_storage_key_unique" UNIQUE("thumbnail_storage_key");