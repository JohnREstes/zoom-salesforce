ALTER TABLE zoom_sms_sessions
ADD COLUMN reconcile_until TIMESTAMPTZ;

CREATE INDEX idx_zoom_sms_sessions_reconcile_until
ON zoom_sms_sessions (reconcile_until)
WHERE reconcile_until IS NOT NULL;