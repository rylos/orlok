CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "wiki_embeddings" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	"page_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_embeddings" ADD CONSTRAINT "wiki_embeddings_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;