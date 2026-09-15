BEGIN;

CREATE TABLE IF NOT EXISTS salesforce_contact_phone_mappings (
    id BIGSERIAL PRIMARY KEY,
    installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
    normalized_phone TEXT NOT NULL,
    salesforce_contact_id TEXT NOT NULL,
    salesforce_account_id TEXT NULL,
    source TEXT NOT NULL DEFAULT 'SALESFORCE_CONTACT_DISCOVERY',
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT salesforce_contact_phone_mappings_phone_not_blank
        CHECK (BTRIM(normalized_phone) <> ''),
    CONSTRAINT salesforce_contact_phone_mappings_contact_not_blank
        CHECK (BTRIM(salesforce_contact_id) <> ''),
    CONSTRAINT salesforce_contact_phone_mappings_unique
        UNIQUE (installation_id, normalized_phone, salesforce_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_contact_phone_mapping_lookup
    ON salesforce_contact_phone_mappings (installation_id, normalized_phone);

CREATE INDEX IF NOT EXISTS idx_sf_contact_phone_mapping_contact
    ON salesforce_contact_phone_mappings (installation_id, salesforce_contact_id);

COMMIT;
