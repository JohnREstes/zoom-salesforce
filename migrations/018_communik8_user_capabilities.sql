-- 018_communik8_user_capabilities.sql
-- Purpose:
--   Add a durable, package-independent capability model for Communik8 users.
--   This supports premium/elevated features such as organization-wide message
--   visibility without weakening the normal per-user security boundary.
--
-- Design notes:
--   - One row per Communik8 user + capability key.
--   - Capabilities are tenant-scoped through installation_id.
--   - capability_key is text to allow future product features without schema
--     changes for every new capability.
--   - granted_by records the provisioning/licensing source at a high level.
--   - expires_at supports temporary entitlements later.
--   - Metadata only; do not store message content here.

BEGIN;

CREATE TABLE IF NOT EXISTS communic8_user_capabilities (
    id BIGSERIAL PRIMARY KEY,

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    communic8_user_id BIGINT NOT NULL
        REFERENCES communic8_users(id)
        ON DELETE CASCADE,

    capability_key TEXT NOT NULL,

    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    granted_by TEXT NULL,

    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    expires_at TIMESTAMPTZ NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT communic8_user_capabilities_key_not_blank
        CHECK (length(btrim(capability_key)) > 0),

    CONSTRAINT communic8_user_capabilities_unique
        UNIQUE (
            installation_id,
            communic8_user_id,
            capability_key
        )
);

CREATE INDEX IF NOT EXISTS idx_communic8_user_capabilities_installation
    ON communic8_user_capabilities (
        installation_id
    );

CREATE INDEX IF NOT EXISTS idx_communic8_user_capabilities_user
    ON communic8_user_capabilities (
        communic8_user_id
    );

CREATE INDEX IF NOT EXISTS idx_communic8_user_capabilities_enabled
    ON communic8_user_capabilities (
        installation_id,
        capability_key,
        communic8_user_id
    )
    WHERE is_enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_communic8_user_capabilities_expires
    ON communic8_user_capabilities (
        expires_at
    )
    WHERE expires_at IS NOT NULL;

-- Runtime role permissions.
GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE communic8_user_capabilities
    TO zoom_salesforce_api;

GRANT USAGE, SELECT
    ON SEQUENCE communic8_user_capabilities_id_seq
    TO zoom_salesforce_api;

COMMIT;
