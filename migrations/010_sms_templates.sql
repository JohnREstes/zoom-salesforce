CREATE TABLE sms_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    scope VARCHAR(20) NOT NULL
        CHECK (scope IN ('PERSONAL', 'SHARED')),

    name VARCHAR(150) NOT NULL,

    body TEXT NOT NULL,

    created_by_salesforce_user_id VARCHAR(18),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sms_templates_installation_id
    ON sms_templates (installation_id);

CREATE INDEX idx_sms_templates_scope
    ON sms_templates (scope);

CREATE INDEX idx_sms_templates_created_by_salesforce_user_id
    ON sms_templates (created_by_salesforce_user_id);

CREATE UNIQUE INDEX idx_sms_templates_shared_name_unique
    ON sms_templates (installation_id, LOWER(name))
    WHERE scope = 'SHARED' AND is_active = TRUE;

CREATE UNIQUE INDEX idx_sms_templates_personal_name_unique
    ON sms_templates (
        installation_id,
        created_by_salesforce_user_id,
        LOWER(name)
    )
    WHERE scope = 'PERSONAL' AND is_active = TRUE;