CREATE TABLE "generation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"content_pack_id" integer NOT NULL,
	"selected_brand_template_id" integer,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "generation_runs_snapshot_object_check" CHECK (jsonb_typeof("generation_runs"."snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD COLUMN "current_render_config_id" integer;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_content_pack_id_content_packs_id_fk" FOREIGN KEY ("content_pack_id") REFERENCES "public"."content_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_selected_brand_template_id_brand_templates_id_fk" FOREIGN KEY ("selected_brand_template_id") REFERENCES "public"."brand_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_runs_content_pack_created_idx" ON "generation_runs" USING btree ("content_pack_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_runs_selected_brand_template_idx" ON "generation_runs" USING btree ("selected_brand_template_id");--> statement-breakpoint
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_current_render_config_id_clip_render_configs_id_fk" FOREIGN KEY ("current_render_config_id") REFERENCES "public"."clip_render_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_candidates_current_render_config_idx" ON "clip_candidates" USING btree ("current_render_config_id") WHERE "clip_candidates"."current_render_config_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rendered_clips_render_config_idx" ON "rendered_clips" USING btree ("clip_render_config_id") WHERE "rendered_clips"."clip_render_config_id" is not null;