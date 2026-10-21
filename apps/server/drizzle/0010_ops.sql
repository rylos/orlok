CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid,
	"actor_user_id" uuid,
	"actor_colleague_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "colleague_ops_policies" (
	"colleague_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'allowlist' NOT NULL,
	"node_ids" jsonb,
	"runner" boolean DEFAULT true NOT NULL,
	"allow_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mcp_server_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"username" text,
	"secret_encrypted" text NOT NULL,
	"passphrase_encrypted" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"address" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"credential_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"host_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"colleague_id" uuid,
	"conversation_id" uuid,
	"requested_for_user_id" uuid,
	"node_id" uuid,
	"target_kind" text NOT NULL,
	"target_name" text NOT NULL,
	"shell" text NOT NULL,
	"command" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"timeout_seconds" integer DEFAULT 120 NOT NULL,
	"classification" jsonb NOT NULL,
	"status" text NOT NULL,
	"exit_code" integer,
	"output" text DEFAULT '' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"error" text,
	"decided_by_user_id" uuid,
	"reported" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ops_job_ids" jsonb;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_colleague_id_colleagues_id_fk" FOREIGN KEY ("actor_colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colleague_ops_policies" ADD CONSTRAINT "colleague_ops_policies_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_colleague_id_colleagues_id_fk" FOREIGN KEY ("colleague_id") REFERENCES "public"."colleagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_requested_for_user_id_users_id_fk" FOREIGN KEY ("requested_for_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_office_created_idx" ON "audit_events" USING btree ("office_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_office_name_idx" ON "credentials" USING btree ("office_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_office_name_idx" ON "nodes" USING btree ("office_id","name");--> statement-breakpoint
CREATE INDEX "ops_jobs_office_created_idx" ON "ops_jobs" USING btree ("office_id","created_at");--> statement-breakpoint
CREATE INDEX "ops_jobs_status_idx" ON "ops_jobs" USING btree ("status");