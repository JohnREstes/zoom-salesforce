CREATE TABLE salesforce_oauth_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    state_hash TEXT NOT NULL,

    code_verifier_encrypted TEXT NOT NULL,

    login_url TEXT NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX salesforce_oauth_attempts_state_hash_unique
    ON salesforce_oauth_attempts(state_hash);

CREATE INDEX salesforce_oauth_attempts_installation_idx
    ON salesforce_oauth_attempts(installation_id);

CREATE INDEX salesforce_oauth_attempts_expires_idx
    ON salesforce_oauth_attempts(expires_at);