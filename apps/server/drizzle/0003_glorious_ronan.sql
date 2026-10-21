CREATE TABLE "colleagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"profile_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"colleague_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"error_code" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "office_members" (
	"office_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "office_members_office_id_user_id_pk" PRIMARY KEY("office_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "offices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offices_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "colleagues" ADD CONSTRAINT "colleagues_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colleagues" ADD CONSTRAINT "colleagues_profile_id_model_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_members" ADD CONSTRAINT "office_members_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_members" ADD CONSTRAINT "office_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "colleagues_office_name_idx" ON "colleagues" USING btree ("office_id","name");--> statement-breakpoint
CREATE INDEX "conversations_user_colleague_idx" ON "conversations" USING btree ("user_id","colleague_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "office_members_user_id_idx" ON "office_members" USING btree ("user_id");