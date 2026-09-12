CREATE TABLE zoom_user_oauth_tokens (
    id BIGSERIAL PRIMARY KEY,

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    communic8_user_id BIGINT NOT NULL
        REFERENCES communic8_users(id)
        ON DELETE CASCADE,

    zoom_user_id TEXT NOT NULL,

    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,

    access_token_expires_at TIMESTAMPTZ NOT NULL,

    scope TEXT,
    token_type VARCHAR(50),

    authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (installation_id, communic8_user_id),
    UNIQUE (installation_id, zoom_user_id)
);

CREATE INDEX idx_zoom_user_oauth_tokens_installation
ON zoom_user_oauth_tokens (installation_id);

CREATE INDEX idx_zoom_user_oauth_tokens_communic8_user
ON zoom_user_oauth_tokens (communic8_user_id);