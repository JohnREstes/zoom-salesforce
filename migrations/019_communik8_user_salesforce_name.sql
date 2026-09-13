-- 019_communic8_user_salesforce_name.sql
-- Persist the Salesforce display name for a mapped Communik8 user.
-- This supports historical organization-message attribution without
-- requiring a live Salesforce lookup when rendering message history.

ALTER TABLE communic8_users
    ADD COLUMN IF NOT EXISTS salesforce_name TEXT NULL;

COMMENT ON COLUMN communic8_users.salesforce_name IS
    'Last synchronized Salesforce User.Name for this mapped Communik8 user.';
