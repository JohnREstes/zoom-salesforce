CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255),
    zoom_account_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_installations_zoom_account_id
ON installations (zoom_account_id)
WHERE zoom_account_id IS NOT NULL;

ALTER TABLE zoom_oauth_tokens
ADD COLUMN installation_id UUID;

ALTER TABLE zoom_oauth_tokens
ADD CONSTRAINT fk_zoom_oauth_tokens_installation
FOREIGN KEY (installation_id)
REFERENCES installations(id)
ON DELETE CASCADE;

CREATE INDEX idx_zoom_oauth_tokens_installation_id
ON zoom_oauth_tokens (installation_id);