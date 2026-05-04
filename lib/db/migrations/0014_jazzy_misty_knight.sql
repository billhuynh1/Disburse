CREATE TABLE "linked_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"platform" varchar(50) NOT NULL,
	"platform_account_id" varchar(255) NOT NULL,
	"platform_account_name" varchar(255),
	"platform_account_username" varchar(255),
	"platform_account_image" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linked_accounts_user_platform_idx" ON "linked_accounts" USING btree ("user_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_unique_account_idx" ON "linked_accounts" USING btree ("user_id","platform","platform_account_id");