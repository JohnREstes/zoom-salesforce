CREATE TABLE zoom_user_oauth_attempts (
    id BIGSERIAL PRIMARY KEY,

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    communic8_user_id BIGINT NOT NULL
        REFERENCES communic8_users(id)
        ON DELETE CASCADE,

    salesforce_user_id TEXT NOT NULL,

    expected_zoom_user_id TEXT NOT NULL,

    state_hash TEXT NOT NULL UNIQUE,

    expires_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_zoom_user_oauth_attempts_installation
ON zoom_user_oauth_attempts (installation_id);

CREATE INDEX idx_zoom_user_oauth_attempts_communic8_user
ON zoom_user_oauth_attempts (communic8_user_id);

CREATE INDEX idx_zoom_user_oauth_attempts_expires
ON zoom_user_oauth_attempts (expires_at);