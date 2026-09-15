-- 022_salesforce_contact_directory_sync.sql
-- Extend durable Contact-phone mappings with a source owned by the
-- proactive Salesforce Contact directory synchronization process.

BEGIN;

ALTER TABLE salesforce_contact_phone_mappings
    DROP CONSTRAINT IF EXISTS
        salesforce_contact_phone_mappings_source_check;

ALTER TABLE salesforce_contact_phone_mappings
    ADD CONSTRAINT
        salesforce_contact_phone_mappings_source_check
    CHECK (
        source IN (
            'SALESFORCE_CONTACT_DISCOVERY',
            'DURABLE_PHONE_MAPPING',
            'SALESFORCE_CONTACT_DIRECTORY_SYNC'
        )
    );

COMMIT;
