-- =============================================================================
-- 041 - Practice-scoped Executive Insight webhook
-- =============================================================================
-- The browser calls Luminary with its user session. Luminary then calls the
-- practice's n8n workflow, so webhook routing and signing secrets never enter
-- browser state and one practice cannot select another practice's workflow.

SET search_path = luminary, public;

ALTER TABLE luminary.practice_settings
  ADD COLUMN IF NOT EXISTS executive_insight_webhook_url text,
  ADD COLUMN IF NOT EXISTS executive_insight_webhook_secret text;

