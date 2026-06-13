ALTER TABLE "brand_templates" ADD COLUMN "enabled_aspect_ratios" jsonb DEFAULT '["9_16"]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "brand_templates" SET "enabled_aspect_ratios" = jsonb_build_array("aspect_ratio");--> statement-breakpoint
CREATE TABLE "clip_render_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"content_pack_id" integer NOT NULL,
	"source_asset_id" integer NOT NULL,
	"clip_candidate_id" integer NOT NULL,
	"generation_run_id" text NOT NULL,
	"aspect_ratio" varchar(20) DEFAULT '9_16' NOT NULL,
	"layout" varchar(40) DEFAULT 'default' NOT NULL,
	"layout_ratio" varchar(20),
	"captions_enabled" boolean DEFAULT true NOT NULL,
	"caption_style" varchar(40) DEFAULT 'default' NOT NULL,
	"caption_font_asset_id" integer,
	"caption_font_family" varchar(120),
	"caption_font_color" varchar(20) DEFAULT '#ffffff' NOT NULL,
	"caption_highlight_color" varchar(20) DEFAULT '#facc15' NOT NULL,
	"caption_position" varchar(20) DEFAULT 'bottom' NOT NULL,
	"caption_animation" varchar(20) DEFAULT 'none' NOT NULL,
	"brand_template_id" integer,
	"overlay_logo_asset_id" integer,
	"cta_url" text,
	"intro_video_asset_id" integer,
	"outro_video_asset_id" integer,
	"crop_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"facecam_detection_id" integer,
	"facecam_detected" boolean DEFAULT false NOT NULL,
	"auto_edit_preset" varchar(80) DEFAULT 'default_short_form_v1' NOT NULL,
	"config_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD COLUMN "clip_render_config_id" integer;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_content_pack_id_content_packs_id_fk" FOREIGN KEY ("content_pack_id") REFERENCES "public"."content_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_clip_candidate_id_clip_candidates_id_fk" FOREIGN KEY ("clip_candidate_id") REFERENCES "public"."clip_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_caption_font_asset_id_reusable_assets_id_fk" FOREIGN KEY ("caption_font_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_brand_template_id_brand_templates_id_fk" FOREIGN KEY ("brand_template_id") REFERENCES "public"."brand_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_overlay_logo_asset_id_reusable_assets_id_fk" FOREIGN KEY ("overlay_logo_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_intro_video_asset_id_reusable_assets_id_fk" FOREIGN KEY ("intro_video_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_outro_video_asset_id_reusable_assets_id_fk" FOREIGN KEY ("outro_video_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_configs" ADD CONSTRAINT "clip_render_configs_facecam_detection_id_clip_candidate_facecam_detections_id_fk" FOREIGN KEY ("facecam_detection_id") REFERENCES "public"."clip_candidate_facecam_detections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_clips" ADD CONSTRAINT "rendered_clips_clip_render_config_id_clip_render_configs_id_fk" FOREIGN KEY ("clip_render_config_id") REFERENCES "public"."clip_render_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_render_configs_candidate_idx" ON "clip_render_configs" USING btree ("clip_candidate_id");--> statement-breakpoint
CREATE INDEX "clip_render_configs_content_pack_idx" ON "clip_render_configs" USING btree ("content_pack_id");--> statement-breakpoint
CREATE INDEX "clip_render_configs_user_updated_idx" ON "clip_render_configs" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_render_configs_candidate_layout_config_idx" ON "clip_render_configs" USING btree ("clip_candidate_id","aspect_ratio","layout","config_hash");
