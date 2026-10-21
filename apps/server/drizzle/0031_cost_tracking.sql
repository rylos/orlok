CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"office_id" uuid,
	"user_id" uuid,
	"monthly_limit_micros" bigint NOT NULL,
	"warn_percent" integer NOT NULL,
	"warned_month" text,
	"exceeded_month" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_scope_unique" UNIQUE NULLS NOT DISTINCT("scope","office_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"rates" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_provider_id_model_pk" PRIMARY KEY("provider_id","model")
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid,
	"user_id" uuid,
	"colleague_id" uuid,
	"conversation_id" uuid,
	"purpose" text NOT NULL,
	"provider_id" uuid,
	"provider_name" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_status" text NOT NULL,
	"cost_micros" bigint,
	"rates" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "billing" text DEFAULT 'per_token' NOT NULL;--> statement-breakpoint
-- Local models cost nothing per call.
UPDATE "model_providers" SET "billing" = 'included' WHERE "kind" = 'ollama';--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usage_created_idx" ON "model_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_usage_office_created_idx" ON "model_usage" USING btree ("office_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_user_created_idx" ON "model_usage" USING btree ("user_id","created_at");