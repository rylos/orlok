ALTER TABLE "colleague_ops_policies" ADD COLUMN "accesses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Everything a colleague can reach today is written down host by host, with the credential the
-- host itself carried, so nobody loses access the day this ships. An explicit list first.
UPDATE "colleague_ops_policies" p
SET "accesses" = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('hostId', h."id", 'credentialId', h."credential_id"))
  FROM "hosts" h
  JOIN "colleagues" c ON c."id" = p."colleague_id"
  WHERE h."office_id" = c."office_id"
    AND h."credential_id" IS NOT NULL
    AND p."node_ids" @> to_jsonb(h."id"::text)
), '[]'::jsonb)
WHERE p."node_ids" IS NOT NULL;--> statement-breakpoint
-- Then "every enabled host of the office", which is what a null list used to mean.
UPDATE "colleague_ops_policies" p
SET "accesses" = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('hostId', h."id", 'credentialId', h."credential_id"))
  FROM "hosts" h
  JOIN "colleagues" c ON c."id" = p."colleague_id"
  WHERE h."office_id" = c."office_id"
    AND h."credential_id" IS NOT NULL
    AND h."enabled"
), '[]'::jsonb)
WHERE p."node_ids" IS NULL;--> statement-breakpoint
-- Colleagues that never had a policy saved were on that same default and need a row of their own.
INSERT INTO "colleague_ops_policies" ("colleague_id", "accesses")
SELECT c."id", (
  SELECT jsonb_agg(jsonb_build_object('hostId', h."id", 'credentialId', h."credential_id"))
  FROM "hosts" h
  WHERE h."office_id" = c."office_id"
    AND h."credential_id" IS NOT NULL
    AND h."enabled"
)
FROM "colleagues" c
WHERE NOT EXISTS (
    SELECT 1 FROM "colleague_ops_policies" p WHERE p."colleague_id" = c."id"
  )
  AND EXISTS (
    SELECT 1 FROM "hosts" h
    WHERE h."office_id" = c."office_id" AND h."credential_id" IS NOT NULL AND h."enabled"
  );
