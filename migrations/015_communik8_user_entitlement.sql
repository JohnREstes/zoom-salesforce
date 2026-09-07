ALTER TABLE communic8_users
ADD COLUMN is_communik8_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_communik8_users_enabled
ON communic8_users (
    installation_id,
    is_communik8_enabled
)
WHERE is_communik8_enabled = TRUE;