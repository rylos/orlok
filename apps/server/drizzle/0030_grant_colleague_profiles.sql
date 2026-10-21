-- A colleague answers only with a profile its owner is granted (R-MOD-2), and the migrations that
-- gave colleagues an owner granted no profile: the colleagues an installation already had would
-- stay silent, wiki filing included, until an administrator granted them. Each owner is granted
-- the profiles of their colleagues that are neither archived nor deleted.
INSERT INTO "profile_grants" ("user_id", "profile_id")
SELECT DISTINCT "user_id", "profile_id" FROM "colleagues"
WHERE "profile_id" IS NOT NULL AND "archived_at" IS NULL AND "deleted_at" IS NULL
ON CONFLICT DO NOTHING;
