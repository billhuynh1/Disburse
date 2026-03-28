ALTER TABLE "voice_profiles" ADD COLUMN "tone" varchar(100);--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "audience" varchar(150);--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "writing_style_notes" text;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "banned_phrases" text;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "cta_style" varchar(150);