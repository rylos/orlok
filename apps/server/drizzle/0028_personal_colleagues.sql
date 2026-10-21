-- Colleagues belong to the person who creates them (R-ADM-3), and the policy each one had goes:
-- the mode comes from the profile, hosts from the person's credentials, MCP servers from the
-- office (R-OPS-4). Existing colleagues go to the first administrator, so the wiki still says
-- who wrote what; other people's conversations and "allow always" rules with them go, and the
-- approvals still waiting for those people are cancelled. Disabled colleagues are archived.
ALTER TABLE "colleagues" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "colleagues" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "colleagues" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "colleagues" SET "user_id" = (
	SELECT "id" FROM "users" WHERE "role" = 'admin'
	ORDER BY "disabled_at" IS NOT NULL, "created_at", "id" LIMIT 1
);--> statement-breakpoint
UPDATE "colleagues" SET "archived_at" = now() WHERE NOT "enabled";--> statement-breakpoint
UPDATE "ops_jobs" SET "status" = 'stopped', "finished_at" = now() FROM "colleagues"
	WHERE "ops_jobs"."colleague_id" = "colleagues"."id" AND "ops_jobs"."status" = 'pending_approval'
	AND "ops_jobs"."requested_for_user_id" IS DISTINCT FROM "colleagues"."user_id";--> statement-breakpoint
UPDATE "ops_plans" SET "status" = 'stopped', "finished_at" = now() FROM "colleagues"
	WHERE "ops_plans"."colleague_id" = "colleagues"."id" AND "ops_plans"."status" = 'pending_approval'
	AND "ops_plans"."requested_for_user_id" IS DISTINCT FROM "colleagues"."user_id";--> statement-breakpoint
DELETE FROM "conversations" USING "colleagues"
	WHERE "conversations"."colleague_id" = "colleagues"."id"
	AND "conversations"."user_id" IS DISTINCT FROM "colleagues"."user_id";--> statement-breakpoint
DELETE FROM "chat_attachments" USING "colleagues"
	WHERE "chat_attachments"."colleague_id" = "colleagues"."id"
	AND "chat_attachments"."user_id" IS DISTINCT FROM "colleagues"."user_id";--> statement-breakpoint
DELETE FROM "personal_command_rules" USING "colleagues"
	WHERE "personal_command_rules"."colleague_id" = "colleagues"."id"
	AND "personal_command_rules"."user_id" IS DISTINCT FROM "colleagues"."user_id";--> statement-breakpoint
DELETE FROM "colleagues" WHERE "user_id" IS NULL;--> statement-breakpoint
-- Names are now unique whatever their case: "sysadmin" next to "Sysadmin" becomes "sysadmin 2".
UPDATE "colleagues" SET "name" = "renamed"."name" FROM (
	SELECT "id", "name" || ' ' || row_number() OVER "same" AS "name", row_number() OVER "same" AS "n"
	FROM "colleagues"
	WINDOW "same" AS (PARTITION BY "office_id", lower("name") ORDER BY "created_at", "id")
) AS "renamed" WHERE "colleagues"."id" = "renamed"."id" AND "renamed"."n" > 1;--> statement-breakpoint
ALTER TABLE "colleague_ops_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "colleague_ops_policies" CASCADE;--> statement-breakpoint
DROP INDEX "colleagues_office_name_idx";--> statement-breakpoint
ALTER TABLE "colleagues" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "colleagues" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "colleagues" ADD CONSTRAINT "colleagues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "colleagues_owner_name_idx" ON "colleagues" USING btree ("user_id","office_id",lower("name")) WHERE "colleagues"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "colleagues_office_idx" ON "colleagues" USING btree ("office_id");
