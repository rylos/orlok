-- Block 4 (2026-10-05): "allow always" remembers command types per person, valid with all
-- their colleagues, on every host and on the runner. The exact commands remembered until now
-- are dropped: turned into types they would allow more than each person approved.
CREATE TABLE "approved_command_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"shell" text NOT NULL,
	"type" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approved_command_types" ADD CONSTRAINT "approved_command_types_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approved_command_types_unique" ON "approved_command_types" USING btree ("user_id","shell",(case when "shell" = 'powershell' then lower("type") else "type" end));--> statement-breakpoint
DROP TABLE "personal_command_rules" CASCADE;
