CREATE TABLE "telegram_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"username" text,
	"colleague_id" uuid,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_accounts_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_by_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;