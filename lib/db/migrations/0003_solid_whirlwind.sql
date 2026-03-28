ALTER TABLE "source_assets" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "source_assets" ADD COLUMN "file_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "source_assets" ADD CONSTRAINT "source_assets_storage_key_unique" UNIQUE("storage_key");