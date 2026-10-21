CREATE TABLE "wiki_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"format" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"colleague_id" uuid,
	"uploaded_by_user_id" uuid,
	"edits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "wiki_edits" jsonb;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD CONSTRAINT "wiki_sources_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD CONSTRAINT "wiki_sources_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD CONSTRAINT "wiki_sources_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_sources_office_created_idx" ON "wiki_sources" USING btree ("office_id","created_at");--> statement-breakpoint
CREATE INDEX "wiki_sources_status_idx" ON "wiki_sources" USING btree ("status","created_at");