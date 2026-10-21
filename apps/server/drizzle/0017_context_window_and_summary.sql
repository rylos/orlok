ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_through_message_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD COLUMN "context_window" integer;