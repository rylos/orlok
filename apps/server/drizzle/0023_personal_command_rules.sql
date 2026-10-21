CREATE TABLE "personal_command_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"colleague_id" uuid NOT NULL,
	"host_id" uuid,
	"shell" text NOT NULL,
	"program" text NOT NULL,
	"arg_pattern" text NOT NULL,
	"command" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_command_rules_unique" UNIQUE NULLS NOT DISTINCT("user_id","colleague_id","host_id","shell","command")
);
--> statement-breakpoint
ALTER TABLE "personal_command_rules" ADD CONSTRAINT "personal_command_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_command_rules" ADD CONSTRAINT "personal_command_rules_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_command_rules" ADD CONSTRAINT "personal_command_rules_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_command_rules_colleague_idx" ON "personal_command_rules" USING btree ("colleague_id");--> statement-breakpoint
-- "Allow always" used to write into the colleague's policy, for everyone. Each such rule goes back
-- to the person who approved it, on the host of the approval; the rules whose approval cannot be
-- found stay in the policy, where an administrator sees them among the rules for everyone.
CREATE TEMPORARY TABLE "approved_rule_origins" AS
SELECT DISTINCT ON (p."colleague_id", r->>'id')
  p."colleague_id", r->>'id' AS "rule_id", r->>'program' AS "program",
  r->>'argPattern' AS "arg_pattern", j."decided_by_user_id" AS "user_id", j."host_id",
  j."shell", trim(j."command") AS "command", j."finished_at"
FROM "colleague_ops_policies" p
CROSS JOIN LATERAL jsonb_array_elements(p."allow_rules") r
JOIN "ops_jobs" j
  ON j."id"::text LIKE substr(r->>'id', 10) || '%'
  AND j."colleague_id" = p."colleague_id"
WHERE r->>'id' LIKE 'approved-%'
  AND j."decided_by_user_id" IS NOT NULL
  AND (j."target_kind" = 'runner' OR (j."target_kind" = 'host' AND j."host_id" IS NOT NULL))
ORDER BY p."colleague_id", r->>'id', j."created_at";
--> statement-breakpoint
INSERT INTO "personal_command_rules"
  ("user_id", "colleague_id", "host_id", "shell", "program", "arg_pattern", "command", "created_at")
SELECT "user_id", "colleague_id", "host_id", "shell", "program", coalesce("arg_pattern", ''), "command",
  coalesce("finished_at", now())
FROM "approved_rule_origins"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "colleague_ops_policies" p
SET "allow_rules" = coalesce((
  SELECT jsonb_agg(r ORDER BY n)
  FROM jsonb_array_elements(p."allow_rules") WITH ORDINALITY AS e(r, n)
  WHERE NOT EXISTS (
    SELECT 1 FROM "approved_rule_origins" o
    WHERE o."colleague_id" = p."colleague_id" AND o."rule_id" = r->>'id'
  )
), '[]'::jsonb)
WHERE EXISTS (SELECT 1 FROM "approved_rule_origins" o WHERE o."colleague_id" = p."colleague_id");
--> statement-breakpoint
DROP TABLE "approved_rule_origins";
