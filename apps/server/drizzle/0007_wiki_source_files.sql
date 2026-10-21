ALTER TABLE "wiki_sources" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "sha256" text NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "data" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "ocr_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD COLUMN "image_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_sources_office_sha256_idx" ON "wiki_sources" USING btree ("office_id","sha256");