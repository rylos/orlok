-- A page is embedded in as many pieces as it needs, so nothing past the first pages is lost.
ALTER TABLE "wiki_embeddings" ADD COLUMN "chunk" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_embeddings" DROP CONSTRAINT "wiki_embeddings_pkey";--> statement-breakpoint
ALTER TABLE "wiki_embeddings" ADD CONSTRAINT "wiki_embeddings_page_id_chunk_pk" PRIMARY KEY("page_id","chunk");--> statement-breakpoint
-- The rows already there embed a truncated page: the worker rebuilds them whole.
DELETE FROM "wiki_embeddings";
