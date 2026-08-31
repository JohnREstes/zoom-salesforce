ALTER TABLE installations
ADD COLUMN salesforce_api_key_hash TEXT;

CREATE UNIQUE INDEX idx_installations_salesforce_api_key_hash
ON installations (salesforce_api_key_hash)
WHERE salesforce_api_key_hash IS NOT NULL;
