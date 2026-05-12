CREATE TABLE "clip_edit_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"content_pack_id" integer NOT NULL,
	"source_asset_id" integer NOT NULL,
	"clip_candidate_id" integer NOT NULL,
	"aspect_ratio" varchar(20) DEFAULT '9_16' NOT NULL,
	"layout" varchar(40) DEFAULT 'default' NOT NULL,
	"layout_ratio" varchar(20),
	"captions_enabled" boolean DEFAULT true NOT NULL,
	"caption_style" varchar(40) DEFAULT 'default' NOT NULL,
	"caption_font_asset_id" integer,
	"facecam_detection_id" integer,
	"facecam_detected" boolean DEFAULT false NOT NULL,
	"auto_edit_preset" varchar(80) DEFAULT 'default_short_form_v1' NOT NULL,
	"auto_edit_applied_at" timestamp,
	"config_version" integer DEFAULT 1 NOT NULL,
	"config_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "edit_config_id" integer;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "edit_config_version" integer;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "edit_config_hash" text;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_content_pack_id_content_packs_id_fk" FOREIGN KEY ("content_pack_id") REFERENCES "public"."content_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_clip_candidate_id_clip_candidates_id_fk" FOREIGN KEY ("clip_candidate_id") REFERENCES "public"."clip_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_caption_font_asset_id_reusable_assets_id_fk" FOREIGN KEY ("caption_font_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_facecam_detection_id_clip_candidate_facecam_detections_id_fk" FOREIGN KEY ("facecam_detection_id") REFERENCES "public"."clip_candidate_facecam_detections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD CONSTRAINT "rendered_clips_edit_config_id_clip_edit_configs_id_fk" FOREIGN KEY ("edit_config_id") REFERENCES "public"."clip_edit_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_edit_configs_candidate_idx" ON "clip_edit_configs" USING btree ("clip_candidate_id");--> statement-breakpoint
CREATE INDEX "clip_edit_configs_content_pack_idx" ON "clip_edit_configs" USING btree ("content_pack_id");--> statement-breakpoint
CREATE INDEX "clip_edit_configs_user_updated_idx" ON "clip_edit_configs" USING btree ("user_id","updated_at");--> statement-breakpoint
DROP INDEX "rendered_clips_candidate_variant_layout_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "rendered_clips_candidate_variant_layout_config_idx" ON "rendered_clips" USING btree ("clip_candidate_id","variant","layout","edit_config_hash");--> statement-breakpoint
INSERT INTO "clip_edit_configs" (
	"user_id",
	"content_pack_id",
	"source_asset_id",
	"clip_candidate_id",
	"aspect_ratio",
	"layout",
	"layout_ratio",
	"captions_enabled",
	"caption_style",
	"caption_font_asset_id",
	"facecam_detection_id",
	"facecam_detected",
	"auto_edit_preset",
	"auto_edit_applied_at",
	"config_version",
	"config_hash",
	"created_at",
	"updated_at"
)
SELECT
	"user_id",
	"content_pack_id",
	"source_asset_id",
	"id",
	'9_16',
	'default',
	NULL,
	true,
	'default',
	NULL,
	NULL,
	false,
	'default_short_form_v1',
	"created_at",
	1,
	md5('{"aspectRatio":"9_16","layout":"default","layoutRatio":null,"captionsEnabled":true,"captionStyle":"default","captionFontAssetId":null,"facecamDetectionId":null,"facecamDetected":false,"autoEditPreset":"default_short_form_v1"}'),
	"created_at",
	"updated_at"
FROM "clip_candidates"
ON CONFLICT ("clip_candidate_id") DO NOTHING;
