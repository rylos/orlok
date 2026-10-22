DROP INDEX "colleagues_owner_name_idx";--> statement-breakpoint
ALTER TABLE "colleagues" ADD COLUMN "office_wide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "colleagues_office_wide_idx" ON "colleagues" USING btree ("office_id") WHERE "colleagues"."deleted_at" is null and "colleagues"."office_wide";--> statement-breakpoint
CREATE UNIQUE INDEX "colleagues_owner_name_idx" ON "colleagues" USING btree ("user_id","office_id",lower("name")) WHERE "colleagues"."deleted_at" is null and not "colleagues"."office_wide";