-- 000017 down
-- Order matters: the resolver function's SIGNATURE references oauth_provider, so
-- it must be dropped before the type; the table's `provider` column references the
-- type too, so the type drops last.
DROP FUNCTION IF EXISTS app.resolve_oauth_identity_by_sub(oauth_provider, text);
DROP TABLE    IF EXISTS oauth_identities;
DROP TYPE     IF EXISTS oauth_provider;
