-- 012_sms_reconciliation_fsync_probe.sql
--
-- Persist the one-time FSync recovery-probe claim so the behavior
-- remains safe across restarts and multiple backend instances.

ALTER TABLE zoom_sms_sessions
ADD COLUMN IF NOT EXISTS reconcile_fsync_attempted_at TIMESTAMPTZ;
