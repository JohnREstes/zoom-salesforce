ALTER TABLE installations
ADD COLUMN webhook_key UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX idx_installations_webhook_key
ON installations (webhook_key);