CREATE TABLE "transcript_words" (
	"id" serial PRIMARY KEY NOT NULL,
	"transcript_id" integer NOT NULL,
	"sequence" integer NOT NULL,
	"start_time_ms" integer NOT NULL,
	"end_time_ms" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transcript_words" ADD CONSTRAINT "transcript_words_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_words_transcript_sequence_idx" ON "transcript_words" USING btree ("transcript_id","sequence");--> statement-breakpoint
CREATE INDEX "transcript_words_transcript_timing_idx" ON "transcript_words" USING btree ("transcript_id","start_time_ms");