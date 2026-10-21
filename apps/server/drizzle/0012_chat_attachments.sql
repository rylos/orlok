CREATE TABLE "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"colleague_id" uuid NOT NULL,
	"message_id" uuid,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"text" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_attachments_message_idx" ON "chat_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_attachments_user_created_idx" ON "chat_attachments" USING btree ("user_id","created_at");