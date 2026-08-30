CREATE TABLE IF NOT EXISTS zoom_oauth_tokens (
    id BIGSERIAL PRIMARY KEY,

    zoom_account_id VARCHAR(255),

    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,

    access_token_expires_at TIMESTAMPTZ NOT NULL,

    scope TEXT,
    token_type VARCHAR(50),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zoom_oauth_tokens_account_id
    ON zoom_oauth_tokens (zoom_account_id);