CREATE TABLE "model_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"max_output_tokens" integer DEFAULT 16000 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"api_key_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_profiles_provider_id_idx" ON "model_profiles" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_profiles_single_default_idx" ON "model_profiles" USING btree ("is_default") WHERE "model_profiles"."is_default" = true;