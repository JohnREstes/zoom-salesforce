CREATE TABLE salesforce_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    salesforce_org_id VARCHAR(255),

    salesforce_user_id VARCHAR(255),

    instance_url TEXT,

    access_token_encrypted TEXT,

    refresh_token_encrypted TEXT,

    access_token_expires_at TIMESTAMPTZ,

    scope TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX salesforce_connections_installation_unique
    ON salesforce_connections(installation_id);

CREATE INDEX salesforce_connections_org_id_idx
    ON salesforce_connections(salesforce_org_id);