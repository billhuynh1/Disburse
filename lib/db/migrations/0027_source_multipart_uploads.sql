ALTER TABLE "source_assets" ALTER COLUMN "file_size_bytes" TYPE bigint;--> statement-breakpoint
CREATE TABLE "source_upload_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"upload_id" text NOT NULL,
	"part_size_bytes" bigint NOT NULL,
	"total_parts" integer NOT NULL,
	"status" varchar(20) DEFAULT 'uploading' NOT NULL,
	"source_asset_id" integer,
	"failure_reason" text,
	"completed_at" timestamp,
	"aborted_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "source_upload_sessions_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "source_upload_parts" (
	"id" serial PRIMARY KEY NOT NULL,
	"upload_session_id" integer NOT NULL,
	"part_number" integer NOT NULL,
	"byte_start" bigint NOT NULL,
	"byte_end" bigint NOT NULL,
	"size_bytes" bigint NOT NULL,
	"etag" text NOT NULL,
	"checksum_sha256" text,
	"status" varchar(20) DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_asset_thumbnail_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_asset_id" integer NOT NULL,
	"variant" varchar(50) NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "source_asset_thumbnail_variants_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "source_upload_sessions" ADD CONSTRAINT "source_upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_upload_sessions" ADD CONSTRAINT "source_upload_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_upload_sessions" ADD CONSTRAINT "source_upload_sessions_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_upload_parts" ADD CONSTRAINT "source_upload_parts_upload_session_id_source_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."source_upload_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_asset_thumbnail_variants" ADD CONSTRAINT "source_asset_thumbnail_variants_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_upload_sessions_user_project_idempotency_idx" ON "source_upload_sessions" USING btree ("user_id","project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "source_upload_sessions_status_updated_at_idx" ON "source_upload_sessions" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_upload_parts_session_part_idx" ON "source_upload_parts" USING btree ("upload_session_id","part_number");--> statement-breakpoint
CREATE UNIQUE INDEX "source_asset_thumbnail_variants_source_asset_variant_idx" ON "source_asset_thumbnail_variants" USING btree ("source_asset_id","variant");
