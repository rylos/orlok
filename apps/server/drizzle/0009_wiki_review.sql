CREATE TABLE "wiki_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"key" text,
	"title" text NOT NULL,
	"detail" text,
	"slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_slug" text,
	"raised_by_colleague_id" uuid,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN "wiki_purpose" text;--> statement-breakpoint
ALTER TABLE "wiki_review_items" ADD CONSTRAINT "wiki_review_items_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_review_items" ADD CONSTRAINT "wiki_review_items_raised_by_colleague_id_colleagues_id_fk" FOREIGN KEY ("raised_by_colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_review_items" ADD CONSTRAINT "wiki_review_items_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_review_items_office_key_idx" ON "wiki_review_items" USING btree ("office_id","key") WHERE "wiki_review_items"."key" is not null;--> statement-breakpoint
CREATE INDEX "wiki_review_items_office_status_idx" ON "wiki_review_items" USING btree ("office_id","status");