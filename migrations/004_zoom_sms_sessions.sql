CREATE TABLE zoom_sms_sessions (
    id BIGSERIAL PRIMARY KEY,

    installation_id UUID NOT NULL
        REFERENCES installations(id)
        ON DELETE CASCADE,

    zoom_session_id VARCHAR(255) NOT NULL,

    session_type VARCHAR(100),

    last_access_time TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX
    idx_zoom_sms_sessions_installation_zoom_session
ON zoom_sms_sessions (
    installation_id,
    zoom_session_id
);


CREATE TABLE zoom_sms_participants (
    id BIGSERIAL PRIMARY KEY,

    sms_session_id BIGINT NOT NULL
        REFERENCES zoom_sms_sessions(id)
        ON DELETE CASCADE,

    owner_type VARCHAR(100),

    owner_id VARCHAR(255),

    is_session_owner BOOLEAN NOT NULL DEFAULT FALSE,

    phone_number VARCHAR(50),

    display_name VARCHAR(255),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX
    idx_zoom_sms_participants_session
ON zoom_sms_participants (
    sms_session_id
);


CREATE INDEX
    idx_zoom_sms_participants_phone_number
ON zoom_sms_participants (
    phone_number
);


CREATE INDEX
    idx_zoom_sms_participants_owner_id
ON zoom_sms_participants (
    owner_id
);