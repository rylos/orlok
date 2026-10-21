ALTER TABLE "nodes" RENAME TO "hosts";--> statement-breakpoint
ALTER TABLE "hosts" RENAME CONSTRAINT "nodes_office_id_offices_id_fk" TO "hosts_office_id_offices_id_fk";--> statement-breakpoint
ALTER TABLE "hosts" RENAME CONSTRAINT "nodes_credential_id_credentials_id_fk" TO "hosts_credential_id_credentials_id_fk";--> statement-breakpoint
ALTER INDEX "nodes_pkey" RENAME TO "hosts_pkey";--> statement-breakpoint
ALTER INDEX "nodes_office_name_idx" RENAME TO "hosts_office_name_idx";--> statement-breakpoint
ALTER TABLE "ops_jobs" RENAME COLUMN "node_id" TO "host_id";--> statement-breakpoint
ALTER TABLE "ops_jobs" RENAME CONSTRAINT "ops_jobs_node_id_nodes_id_fk" TO "ops_jobs_host_id_hosts_id_fk";--> statement-breakpoint
UPDATE "ops_jobs" SET "target_kind" = 'host' WHERE "target_kind" = 'node';
