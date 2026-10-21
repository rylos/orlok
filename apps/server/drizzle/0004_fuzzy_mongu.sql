CREATE TABLE "invitation_offices" (
	"invitation_id" uuid NOT NULL,
	"office_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "invitation_offices_invitation_id_office_id_pk" PRIMARY KEY("invitation_id","office_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"locale" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitation_offices" ADD CONSTRAINT "invitation_offices_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_offices" ADD CONSTRAINT "invitation_offices_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");