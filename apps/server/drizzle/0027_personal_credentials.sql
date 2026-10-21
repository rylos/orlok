-- Credentials belong to a person and hosts to one registry for the whole installation (R-OPS-1,
-- R-OPS-3). Installations are in a test phase, so office credentials and the hosts handed to
-- colleagues in their policies are dropped; hosts are kept, and a name used in more than one
-- office gets the office name, since names are now unique whatever their case.
DELETE FROM "credentials";--> statement-breakpoint
UPDATE "hosts" SET "name" = "renamed"."name" FROM (
	SELECT "hosts"."id", "hosts"."name" || ' (' || "offices"."name" || ')' || CASE WHEN row_number() OVER "same" > 1 THEN ' ' || row_number() OVER "same" ELSE '' END AS "name"
	FROM "hosts" JOIN "offices" ON "offices"."id" = "hosts"."office_id"
	WHERE lower("hosts"."name") IN (SELECT lower("name") FROM "hosts" GROUP BY lower("name") HAVING count(*) > 1)
	WINDOW "same" AS (PARTITION BY lower("hosts"."name"), "hosts"."office_id" ORDER BY "hosts"."created_at", "hosts"."id")
) AS "renamed" WHERE "hosts"."id" = "renamed"."id";--> statement-breakpoint
CREATE TABLE "credential_hosts" (
	"credential_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "credential_hosts_credential_id_host_id_pk" PRIMARY KEY("credential_id","host_id")
);
--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_office_id_offices_id_fk";
--> statement-breakpoint
ALTER TABLE "hosts" DROP CONSTRAINT "hosts_office_id_offices_id_fk";
--> statement-breakpoint
DROP INDEX "credentials_office_name_idx";--> statement-breakpoint
DROP INDEX "hosts_office_name_idx";--> statement-breakpoint
ALTER TABLE "colleague_ops_policies" DROP COLUMN "accesses";--> statement-breakpoint
ALTER TABLE "credentials" DROP COLUMN "office_id";--> statement-breakpoint
ALTER TABLE "hosts" DROP COLUMN "office_id";--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_hosts" ADD CONSTRAINT "credential_hosts_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_hosts" ADD CONSTRAINT "credential_hosts_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_hosts" ADD CONSTRAINT "credential_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_user_name_idx" ON "credentials" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_hosts_user_host_idx" ON "credential_hosts" USING btree ("user_id","host_id");--> statement-breakpoint
CREATE INDEX "credential_hosts_host_idx" ON "credential_hosts" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_name_idx" ON "hosts" USING btree (lower("name"));
