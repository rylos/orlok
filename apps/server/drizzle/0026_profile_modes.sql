-- A model profile is a model and a mode (R-MOD-2, R-OPS-4); people are granted profiles. The mode
-- leaves the colleague policy. Installations are in a test phase, so nothing is carried over
-- beyond what keeps colleagues answering: existing profiles become "ask", colleagues relying on
-- the default profile get it explicitly, profiles running the same model are merged.
CREATE TABLE "invitation_profiles" (
	"invitation_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	CONSTRAINT "invitation_profiles_invitation_id_profile_id_pk" PRIMARY KEY("invitation_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "profile_grants" (
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_grants_user_id_profile_id_pk" PRIMARY KEY("user_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "model_profiles" ADD COLUMN "mode" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_profiles" ALTER COLUMN "mode" DROP DEFAULT;--> statement-breakpoint
UPDATE "colleagues" SET "profile_id" = (SELECT "id" FROM "model_profiles" WHERE "is_default") WHERE "profile_id" IS NULL;--> statement-breakpoint
CREATE TEMPORARY TABLE "merged_profiles" AS
SELECT "id", "keep" FROM (
	SELECT "id", first_value("id") OVER (PARTITION BY "provider_id", "model" ORDER BY "is_default" DESC, "created_at", "id") AS "keep"
	FROM "model_profiles"
) AS "ranked" WHERE "id" <> "keep";--> statement-breakpoint
UPDATE "colleagues" SET "profile_id" = "merged_profiles"."keep" FROM "merged_profiles" WHERE "colleagues"."profile_id" = "merged_profiles"."id";--> statement-breakpoint
UPDATE "settings" SET "value" = jsonb_set("value", '{visionProfileId}', to_jsonb("merged_profiles"."keep"::text)) FROM "merged_profiles" WHERE "settings"."key" = 'documents' AND "settings"."value"->>'visionProfileId' = "merged_profiles"."id"::text;--> statement-breakpoint
DELETE FROM "model_profiles" USING "merged_profiles" WHERE "model_profiles"."id" = "merged_profiles"."id";--> statement-breakpoint
DROP TABLE "merged_profiles";--> statement-breakpoint
DROP INDEX "model_profiles_single_default_idx";--> statement-breakpoint
ALTER TABLE "model_profiles" DROP COLUMN "is_default";--> statement-breakpoint
ALTER TABLE "invitation_profiles" ADD CONSTRAINT "invitation_profiles_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_profiles" ADD CONSTRAINT "invitation_profiles_profile_id_model_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_grants" ADD CONSTRAINT "profile_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_grants" ADD CONSTRAINT "profile_grants_profile_id_model_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_grants_profile_id_idx" ON "profile_grants" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_profiles_combination_idx" ON "model_profiles" USING btree ("provider_id","model","mode");--> statement-breakpoint
ALTER TABLE "colleague_ops_policies" DROP COLUMN "mode";
