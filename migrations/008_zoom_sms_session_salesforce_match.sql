ALTER TABLE zoom_sms_sessions
ADD COLUMN salesforce_contact_id VARCHAR(18),
ADD COLUMN salesforce_account_id VARCHAR(18),
ADD COLUMN salesforce_matched_at TIMESTAMPTZ;

CREATE INDEX idx_zoom_sms_sessions_salesforce_contact_id
ON zoom_sms_sessions (salesforce_contact_id);

CREATE INDEX idx_zoom_sms_sessions_salesforce_account_id
ON zoom_sms_sessions (salesforce_account_id);