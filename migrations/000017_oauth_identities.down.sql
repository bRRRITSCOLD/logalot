-- 000017 down
-- Drop the table before the type: the `provider` column references oauth_provider,
-- so the type drops last.
DROP TABLE IF EXISTS oauth_identities;
DROP TYPE  IF EXISTS oauth_provider;
