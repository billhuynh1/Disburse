CREATE TABLE "brand_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"caption_font_family" varchar(120),
	"caption_font_color" varchar(20) DEFAULT '#ffffff' NOT NULL,
	"caption_highlight_color" varchar(20) DEFAULT '#facc15' NOT NULL,
	"caption_position" varchar(20) DEFAULT 'bottom' NOT NULL,
	"caption_animation" varchar(20) DEFAULT 'none' NOT NULL,
	"caption_font_asset_id" integer,
	"aspect_ratio" varchar(20) DEFAULT '9_16' NOT NULL,
	"default_layout" varchar(40) DEFAULT 'default' NOT NULL,
	"enabled_layouts" jsonb DEFAULT '["default"]'::jsonb NOT NULL,
	"logo_asset_id" integer,
	"cta_url" text,
	"intro_video_asset_id" integer,
	"outro_video_asset_id" integer,
	"crop_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "caption_font_family" varchar(120);--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "caption_font_color" varchar(20) DEFAULT '#ffffff' NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "caption_highlight_color" varchar(20) DEFAULT '#facc15' NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "caption_position" varchar(20) DEFAULT 'bottom' NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "caption_animation" varchar(20) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "brand_template_id" integer;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "overlay_logo_asset_id" integer;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "cta_url" text;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "intro_video_asset_id" integer;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "outro_video_asset_id" integer;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD COLUMN "crop_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_templates" ADD CONSTRAINT "brand_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_templates" ADD CONSTRAINT "brand_templates_caption_font_asset_id_reusable_assets_id_fk" FOREIGN KEY ("caption_font_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_templates" ADD CONSTRAINT "brand_templates_logo_asset_id_reusable_assets_id_fk" FOREIGN KEY ("logo_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_templates" ADD CONSTRAINT "brand_templates_intro_video_asset_id_reusable_assets_id_fk" FOREIGN KEY ("intro_video_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_templates" ADD CONSTRAINT "brand_templates_outro_video_asset_id_reusable_assets_id_fk" FOREIGN KEY ("outro_video_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_brand_template_id_brand_templates_id_fk" FOREIGN KEY ("brand_template_id") REFERENCES "public"."brand_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_overlay_logo_asset_id_reusable_assets_id_fk" FOREIGN KEY ("overlay_logo_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_intro_video_asset_id_reusable_assets_id_fk" FOREIGN KEY ("intro_video_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edit_configs" ADD CONSTRAINT "clip_edit_configs_outro_video_asset_id_reusable_assets_id_fk" FOREIGN KEY ("outro_video_asset_id") REFERENCES "public"."reusable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_templates_user_updated_idx" ON "brand_templates" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "brand_templates_user_default_idx" ON "brand_templates" USING btree ("user_id","is_default");
