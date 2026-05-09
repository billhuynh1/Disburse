CREATE TABLE "reusable_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"title" varchar(150) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"storage_key" text NOT NULL,
	"storage_url" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reusable_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "clip_publications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"rendered_clip_id" integer NOT NULL,
	"linked_account_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"platform_post_id" varchar(255),
	"platform_url" text,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reusable_assets" ADD CONSTRAINT "reusable_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clip_publications" ADD CONSTRAINT "clip_publications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clip_publications" ADD CONSTRAINT "clip_publications_rendered_clip_id_rendered_clips_id_fk" FOREIGN KEY ("rendered_clip_id") REFERENCES "public"."rendered_clips"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clip_publications" ADD CONSTRAINT "clip_publications_linked_account_id_linked_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "reusable_assets_user_kind_idx" ON "reusable_assets" USING btree ("user_id","kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "reusable_assets_storage_key_idx" ON "reusable_assets" USING btree ("storage_key");
--> statement-breakpoint
CREATE INDEX "clip_publications_rendered_clip_idx" ON "clip_publications" USING btree ("rendered_clip_id");
--> statement-breakpoint
CREATE INDEX "clip_publications_status_idx" ON "clip_publications" USING btree ("status","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "clip_publications_unique_rendered_clip_account_idx" ON "clip_publications" USING btree ("rendered_clip_id","linked_account_id");
