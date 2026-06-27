-- Revoke SELECT on saved_queries from logalot_evaluator (reverse of 000015 up),
-- and restore the prior table-comment state.
--
-- saved_queries was created in 000007 with NO COMMENT ON TABLE, and no migration
-- before 000015 ever set one — so the true prior state is NULL. 000015's up set a
-- comment, so a correct down must clear it back to NULL (not fabricate a comment
-- that never existed).
REVOKE SELECT ON saved_queries FROM logalot_evaluator;

COMMENT ON TABLE saved_queries IS NULL;
