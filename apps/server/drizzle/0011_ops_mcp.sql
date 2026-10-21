CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secrets_encrypted" text,
	"secret_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_policy" text DEFAULT 'readonly_auto' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_refreshed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD COLUMN "mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD COLUMN "tool_name" text;--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD COLUMN "tool_input" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_office_name_idx" ON "mcp_servers" USING btree ("office_id","name");--> statement-breakpoint
ALTER TABLE "ops_jobs" ADD CONSTRAINT "ops_jobs_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE set null ON UPDATE no action;