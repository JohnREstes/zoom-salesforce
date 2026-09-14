-- 020_communik8_salesforce_directory_sync.sql
-- Persist Salesforce-side lifecycle state independently of Zoom state.

BEGIN;

ALTER TABLE communic8_users
    ADD COLUMN IF NOT EXISTS salesforce_is_active BOOLEAN NULL;

ALTER TABLE communic8_users
    ADD COLUMN IF NOT EXISTS salesforce_synced_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN communic8_users.salesforce_is_active IS
    'Last synchronized Salesforce User.IsActive value. Independent of Zoom is_active.';

COMMENT ON COLUMN communic8_users.salesforce_synced_at IS
    'Timestamp of the most recent successful Salesforce directory refresh for this mapped user.';

CREATE INDEX IF NOT EXISTS
    idx_communik8_users_salesforce_synced_at
    ON communic8_users (
        installation_id,
        salesforce_synced_at
    );

COMMIT;
