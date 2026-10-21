ALTER TABLE "messages" ADD COLUMN "wiki_given" jsonb;--> statement-breakpoint
-- Earlier answers stored the pages they were given as the pages they used: keep those as given,
-- and show as used only the ones the answer cites with [[slug]].
UPDATE "messages" SET
  "wiki_given" = "wiki_pages",
  "wiki_pages" = (
    SELECT jsonb_agg(page)
    FROM jsonb_array_elements("messages"."wiki_pages") AS page
    WHERE strpos("messages"."content", '[[' || (page ->> 'slug')) > 0
  )
WHERE "role" = 'assistant' AND "wiki_pages" IS NOT NULL;
