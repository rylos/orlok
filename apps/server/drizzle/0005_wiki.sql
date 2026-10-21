CREATE TABLE "wiki_links" (
	"page_id" uuid NOT NULL,
	"target_slug" text NOT NULL,
	CONSTRAINT "wiki_links_page_id_target_slug_pk" PRIMARY KEY("page_id","target_slug")
);
--> statement-breakpoint
CREATE TABLE "wiki_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"action" text NOT NULL,
	"slug" text,
	"title" text NOT NULL,
	"detail" text,
	"author_user_id" uuid,
	"author_colleague_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"section" text,
	"type" text DEFAULT 'note' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"search" "tsvector" NOT NULL,
	"updated_by_user_id" uuid,
	"updated_by_colleague_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"section" text,
	"type" text NOT NULL,
	"content" text NOT NULL,
	"sources" jsonb NOT NULL,
	"summary" text,
	"author_user_id" uuid,
	"author_colleague_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "wiki_pages" jsonb;--> statement-breakpoint
ALTER TABLE "wiki_links" ADD CONSTRAINT "wiki_links_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_log" ADD CONSTRAINT "wiki_log_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_log" ADD CONSTRAINT "wiki_log_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_log" ADD CONSTRAINT "wiki_log_author_colleague_id_colleagues_id_fk" FOREIGN KEY ("author_colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_updated_by_colleague_id_colleagues_id_fk" FOREIGN KEY ("updated_by_colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD CONSTRAINT "wiki_revisions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD CONSTRAINT "wiki_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD CONSTRAINT "wiki_revisions_author_colleague_id_colleagues_id_fk" FOREIGN KEY ("author_colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_links_target_slug_idx" ON "wiki_links" USING btree ("target_slug");--> statement-breakpoint
CREATE INDEX "wiki_log_office_created_idx" ON "wiki_log" USING btree ("office_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_office_slug_idx" ON "wiki_pages" USING btree ("office_id","slug");--> statement-breakpoint
CREATE INDEX "wiki_pages_search_idx" ON "wiki_pages" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_revisions_page_revision_idx" ON "wiki_revisions" USING btree ("page_id","revision");