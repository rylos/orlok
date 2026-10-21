CREATE TABLE "telegram_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"job_id" uuid,
	"plan_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD CONSTRAINT "telegram_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD CONSTRAINT "telegram_prompts_job_id_ops_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ops_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD CONSTRAINT "telegram_prompts_plan_id_ops_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."ops_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_prompts_created_idx" ON "telegram_prompts" USING btree ("created_at");