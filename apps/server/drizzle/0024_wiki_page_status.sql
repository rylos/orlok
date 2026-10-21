ALTER TABLE "conversations" ADD COLUMN "wiki_reflected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "wiki_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN "wiki_synonyms" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "verified_on" date;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "reviewed_revision" integer;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD COLUMN "status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD COLUMN "verified_on" date;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "outcome" text;