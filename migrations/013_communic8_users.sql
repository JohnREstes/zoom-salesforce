CREATE TABLE communic8_users (
    id BIGSERIAL PRIMARY KEY,

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    salesforce_user_id VARCHAR(18),
    salesforce_email TEXT,

    zoom_user_id TEXT,
    zoom_email TEXT,
    zoom_phone_number TEXT,

    is_sms_capable BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,

    matched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (installation_id, salesforce_user_id),
    UNIQUE (installation_id, zoom_user_id)
);

CREATE INDEX idx_communic8_users_installation
ON communic8_users (installation_id);

CREATE INDEX idx_communic8_users_salesforce_email
ON communic8_users (installation_id, LOWER(salesforce_email));

CREATE INDEX idx_communic8_users_zoom_email
ON communic8_users (installation_id, LOWER(zoom_email));