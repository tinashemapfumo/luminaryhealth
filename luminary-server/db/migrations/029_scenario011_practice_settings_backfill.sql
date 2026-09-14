-- =============================================================================
-- 029 . Scenario 011 practice settings backfill
-- =============================================================================
-- Some older/local fixtures predate the single-row practice_settings insert.
-- Reporting can fall back without it, but the supported settings surface should
-- expose a concrete practice timezone for every active practice.

SET search_path = luminary, public;

INSERT INTO luminary.practice_settings (practice_id, timezone)
SELECT p.id, 'Africa/Harare'
  FROM luminary.practice p
 WHERE p.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM luminary.practice_settings ps
      WHERE ps.practice_id = p.id
   );
