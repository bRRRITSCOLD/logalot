-- 000018 down. The table owns its policy, indexes, trigger, and the global
-- UNIQUE(token_hash); DROP TABLE removes them all. No enum type to drop (role and
-- status are text+CHECK), so no DROP TYPE ordering (unlike 000017).
DROP TABLE IF EXISTS invites;
