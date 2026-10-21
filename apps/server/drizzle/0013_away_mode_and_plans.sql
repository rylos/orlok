CREATE TABLE "office_away_modes" (
	"office_id" uuid PRIMARY KEY NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"periods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"colleague_id" uuid,
	"conversation_id" uuid,
	"requested_for_user_id" uuid,
	"title" text NOT NULL,
	"summary" text,
	"status" text NOT NULL,
	"decided_by_user_id" uuid,
	"reported" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD COLUMN "plan_step" integer;--> statement-breakpoint
ALTER TABLE "office_away_modes" ADD CONSTRAINT "office_away_modes_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_away_modes" ADD CONSTRAINT "office_away_modes_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plans" ADD CONSTRAINT "ops_plans_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plans" ADD CONSTRAINT "ops_plans_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plans" ADD CONSTRAINT "ops_plans_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plans" ADD CONSTRAINT "ops_plans_requested_for_user_id_users_id_fk" FOREIGN KEY ("requested_for_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_plans" ADD CONSTRAINT "ops_plans_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_plans_office_created_idx" ON "ops_plans" USING btree ("office_id","created_at");--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_plan_id_ops_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."ops_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_jobs_plan_idx" ON "ops_jobs" USING btree ("plan_id","plan_step");