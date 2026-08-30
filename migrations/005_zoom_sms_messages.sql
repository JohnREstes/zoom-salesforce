ALTER TABLE zoom_sms_sessions
ADD COLUMN sync_token TEXT;


CREATE TABLE zoom_sms_messages (
    id BIGSERIAL PRIMARY KEY,

    sms_session_id BIGINT NOT NULL
        REFERENCES zoom_sms_sessions(id)
        ON DELETE CASCADE,

    zoom_message_id VARCHAR(255) NOT NULL,

    direction VARCHAR(50),

    message_type VARCHAR(100),

    message_body TEXT,

    message_date_time TIMESTAMPTZ,

    sender JSONB,

    to_members JSONB,

    attachments JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE UNIQUE INDEX
    idx_zoom_sms_messages_session_message
ON zoom_sms_messages (
    sms_session_id,
    zoom_message_id
);


CREATE INDEX
    idx_zoom_sms_messages_session_date
ON zoom_sms_messages (
    sms_session_id,
    message_date_time
);


CREATE INDEX
    idx_zoom_sms_messages_date
ON zoom_sms_messages (
    message_date_time
);