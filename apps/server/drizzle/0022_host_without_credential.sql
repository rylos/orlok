ALTER TABLE "hosts" DROP CONSTRAINT "hosts_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "colleague_ops_policies" DROP COLUMN "node_ids";--> statement-breakpoint
ALTER TABLE "hosts" DROP COLUMN "credential_id";