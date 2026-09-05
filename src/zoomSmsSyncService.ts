import { db } from './db.js';
import { getSmsSessions } from './zoomPhoneService.js';

type ZoomSmsParticipant = {
    owner?: {
        type?: string;
        id?: string;
    };
    is_session_owner?: boolean;
    phone_number?: string;
    display_name?: string;
};

type ZoomSmsSession = {
    session_id: string;
    session_type?: string;
    last_access_time?: string;
    participants?: ZoomSmsParticipant[];
};

type ZoomSmsSessionsResponse = {
    next_page_token?: string;
    sms_sessions?: ZoomSmsSession[];
};

export async function syncSmsSessions(
    installationId: string
): Promise<{
    pagesProcessed: number;
    sessionsProcessed: number;
    participantsProcessed: number;
}> {
    let nextPageToken: string | undefined;
    let pagesProcessed = 0;
    let sessionsProcessed = 0;
    let participantsProcessed = 0;

    do {
        const response =
            await getSmsSessions(
                installationId,
                {
                    pageSize: 100,
                    nextPageToken
                }
            ) as ZoomSmsSessionsResponse;

        pagesProcessed += 1;

        const sessions =
            Array.isArray(response.sms_sessions)
                ? response.sms_sessions
                : [];

        for (const session of sessions) {
            if (!session.session_id) {
                continue;
            }

            const client = await db.connect();

            try {
                await client.query('BEGIN');

                const sessionResult =
                    await client.query(
                        `
                        INSERT INTO zoom_sms_sessions (
                            installation_id,
                            zoom_session_id,
                            session_type,
                            last_access_time
                        )
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (
                            installation_id,
                            zoom_session_id
                        )
                        DO UPDATE SET
                            session_type =
                                EXCLUDED.session_type,
                            last_access_time =
                                EXCLUDED.last_access_time,
                            updated_at = NOW()
                        RETURNING id
                        `,
                        [
                            installationId,
                            session.session_id,
                            session.session_type ?? null,
                            session.last_access_time
                                ? new Date(
                                    session.last_access_time
                                )
                                : null
                        ]
                    );

                const smsSessionId =
                    sessionResult.rows[0].id;

                /*
                 * Replace the participant snapshot for this
                 * session. Zoom is the source of truth here.
                 */
                await client.query(
                    `
                    DELETE FROM zoom_sms_participants
                    WHERE sms_session_id = $1
                    `,
                    [smsSessionId]
                );

                const participants =
                    Array.isArray(session.participants)
                        ? session.participants
                        : [];

                for (const participant of participants) {
                    await client.query(
                        `
                        INSERT INTO zoom_sms_participants (
                            sms_session_id,
                            owner_type,
                            owner_id,
                            is_session_owner,
                            phone_number,
                            display_name
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6
                        )
                        `,
                        [
                            smsSessionId,
                            participant.owner?.type ?? null,
                            participant.owner?.id ?? null,
                            participant.is_session_owner
                                ?? false,
                            participant.phone_number ?? null,
                            participant.display_name ?? null
                        ]
                    );

                    participantsProcessed += 1;
                }

                await client.query('COMMIT');

                sessionsProcessed += 1;
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch {
                    // Preserve original error.
                }

                throw error;
            } finally {
                client.release();
            }
        }

        nextPageToken =
            response.next_page_token || undefined;

    } while (nextPageToken);

    console.log('[ZOOM SMS SYNC SUCCESS]', {
        installationId,
        pagesProcessed,
        sessionsProcessed,
        participantsProcessed
    });

    return {
        pagesProcessed,
        sessionsProcessed,
        participantsProcessed
    };
}

export async function syncSmsSessionSnapshot(
    installationId: string,
    smsSessionId: number
): Promise<{
    found: boolean;
    pagesProcessed: number;
    participantsProcessed: number;
}> {
    const localResult =
        await db.query<{
            zoom_session_id: string;
        }>(
            `
            SELECT zoom_session_id
            FROM zoom_sms_sessions
            WHERE id = $1
              AND installation_id = $2
            LIMIT 1
            `,
            [
                smsSessionId,
                installationId
            ]
        );

    if (localResult.rowCount !== 1) {
        throw new Error(
            'SMS session not found for installation'
        );
    }

    const zoomSessionId =
        localResult.rows[0].zoom_session_id;

    let nextPageToken: string | undefined;
    let pagesProcessed = 0;

    /*
     * These sessions are recent, so they should normally be
     * near the beginning of Zoom's session index.
     *
     * Do not scan an entire large Zoom account every minute.
     */
    const MAX_LOOKUP_PAGES = 10;

    do {
        const response =
            await getSmsSessions(
                installationId,
                {
                    pageSize: 100,
                    nextPageToken
                }
            ) as ZoomSmsSessionsResponse;

        pagesProcessed += 1;

        const sessions =
            Array.isArray(response.sms_sessions)
                ? response.sms_sessions
                : [];

        const zoomSession =
            sessions.find(
                session =>
                    session.session_id ===
                    zoomSessionId
            );

        if (zoomSession) {
            const client = await db.connect();

            try {
                await client.query('BEGIN');

                await client.query(
                    `
                    UPDATE zoom_sms_sessions
                    SET
                        session_type =
                            COALESCE(
                                $1,
                                session_type
                            ),
                        last_access_time =
                            COALESCE(
                                $2,
                                last_access_time
                            ),
                        updated_at = NOW()
                    WHERE id = $3
                      AND installation_id = $4
                    `,
                    [
                        zoomSession.session_type ?? null,
                        zoomSession.last_access_time
                            ? new Date(
                                zoomSession.last_access_time
                            )
                            : null,
                        smsSessionId,
                        installationId
                    ]
                );

                /*
                 * Zoom is the source of truth for the current
                 * participant snapshot.
                 */
                await client.query(
                    `
                    DELETE FROM zoom_sms_participants
                    WHERE sms_session_id = $1
                    `,
                    [smsSessionId]
                );

                const participants =
                    Array.isArray(
                        zoomSession.participants
                    )
                        ? zoomSession.participants
                        : [];

                for (
                    const participant of participants
                ) {
                    await client.query(
                        `
                        INSERT INTO zoom_sms_participants (
                            sms_session_id,
                            owner_type,
                            owner_id,
                            is_session_owner,
                            phone_number,
                            display_name
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6
                        )
                        `,
                        [
                            smsSessionId,
                            participant.owner?.type ??
                                null,
                            participant.owner?.id ??
                                null,
                            participant.is_session_owner ??
                                false,
                            participant.phone_number ??
                                null,
                            participant.display_name ??
                                null
                        ]
                    );
                }

                await client.query('COMMIT');

                console.log(
                    '[ZOOM SMS SESSION SNAPSHOT SYNCED]',
                    {
                        installationId,
                        smsSessionId,
                        pagesProcessed,
                        participantsProcessed:
                            participants.length
                    }
                );

                return {
                    found: true,
                    pagesProcessed,
                    participantsProcessed:
                        participants.length
                };
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch {
                    // Preserve original error.
                }

                throw error;
            } finally {
                client.release();
            }
        }

        nextPageToken =
            response.next_page_token ||
            undefined;

    } while (
        nextPageToken &&
        pagesProcessed < MAX_LOOKUP_PAGES
    );

    console.log(
        '[ZOOM SMS SESSION SNAPSHOT NOT FOUND]',
        {
            installationId,
            smsSessionId,
            pagesProcessed
        }
    );

    return {
        found: false,
        pagesProcessed,
        participantsProcessed: 0
    };
}

export async function ensureSmsSessionFromWebhook(
    installationId: string,
    zoomSessionId: string,
    lastAccessTime?: string
): Promise<{
    smsSessionId: number;
    created: boolean;
}> {
    if (!zoomSessionId) {
        throw new Error(
            'Zoom SMS session ID is required'
        );
    }

    /*
     * First look for an existing session.
     */
    const existingResult = await db.query(
        `
        SELECT id
        FROM zoom_sms_sessions
        WHERE installation_id = $1
          AND zoom_session_id = $2
        LIMIT 1
        `,
        [
            installationId,
            zoomSessionId
        ]
    );

    if (existingResult.rowCount === 1) {
        const smsSessionId = Number(
            existingResult.rows[0].id
        );

        if (lastAccessTime) {
            await db.query(
                `
                UPDATE zoom_sms_sessions
                SET
                    last_access_time = $1,
                    updated_at = NOW()
                WHERE id = $2
                `,
                [
                    new Date(lastAccessTime),
                    smsSessionId
                ]
            );
        }

        console.log('[ZOOM SMS SESSION ENSURED]', {
            installationId,
            smsSessionId,
            created: false
        });

        return {
            smsSessionId,
            created: false
        };
    }

    /*
     * This is a session we have not seen before.
     *
     * ON CONFLICT still protects us if two webhook deliveries
     * arrive at nearly the same time.
     */
    const insertResult = await db.query(
        `
        INSERT INTO zoom_sms_sessions (
            installation_id,
            zoom_session_id,
            last_access_time
        )
        VALUES (
            $1,
            $2,
            $3
        )
        ON CONFLICT (
            installation_id,
            zoom_session_id
        )
        DO UPDATE SET
            last_access_time =
                COALESCE(
                    EXCLUDED.last_access_time,
                    zoom_sms_sessions.last_access_time
                ),
            updated_at = NOW()
        RETURNING
            id,
            (xmax = 0) AS inserted
        `,
        [
            installationId,
            zoomSessionId,
            lastAccessTime
                ? new Date(lastAccessTime)
                : null
        ]
    );

    if (insertResult.rowCount !== 1) {
        throw new Error(
            'Unable to ensure SMS session'
        );
    }

    const smsSessionId = Number(
        insertResult.rows[0].id
    );

    const created =
        insertResult.rows[0].inserted === true;

    console.log('[ZOOM SMS SESSION ENSURED]', {
        installationId,
        smsSessionId,
        created
    });

    return {
        smsSessionId,
        created
    };
}

export async function recoverSmsParticipantsFromMessages(
    installationId: string,
    smsSessionId: number
): Promise<{
    recovered: boolean;
    participantsProcessed: number;
}> {
    const sessionResult =
        await db.query(
            `
            SELECT id
            FROM zoom_sms_sessions
            WHERE id = $1
              AND installation_id = $2
            LIMIT 1
            `,
            [
                smsSessionId,
                installationId
            ]
        );

    if (sessionResult.rowCount !== 1) {
        throw new Error(
            'SMS session not found for installation'
        );
    }

    /*
     * Find the newest persisted Zoom message that contains
     * enough metadata to reconstruct a one-to-one session.
     */
    const messageResult =
        await db.query<{
            direction: string | null;
            sender: unknown;
            to_members: unknown;
        }>(
            `
            SELECT
                direction,
                sender,
                to_members
            FROM zoom_sms_messages
            WHERE sms_session_id = $1
              AND sender IS NOT NULL
              AND to_members IS NOT NULL
            ORDER BY
                message_date_time DESC NULLS LAST,
                id DESC
            LIMIT 10
            `,
            [smsSessionId]
        );

    for (const row of messageResult.rows) {
        const direction =
            row.direction?.toLowerCase();

        if (
            direction !== 'in' &&
            direction !== 'out'
        ) {
            continue;
        }

        const sender =
            asSmsParty(row.sender);

        const toMembers =
            asSmsPartyArray(row.to_members);

        /*
         * For v1 we only reconstruct standard one-to-one
         * conversations. Never guess in a group conversation.
         */
        const recipients =
            toMembers.filter(
                member =>
                    Boolean(member.phone_number)
            );

        if (
            !sender?.phone_number ||
            recipients.length !== 1
        ) {
            continue;
        }

        const recipient = recipients[0];

        if (
            recipient.phone_number ===
            sender.phone_number
        ) {
            continue;
        }

        let owner: SmsRecoveredParty;
        let external: SmsRecoveredParty;

        if (direction === 'in') {
            /*
             * Incoming:
             * sender = external person
             * to_member = Communik8 / Zoom owner
             */
            external = sender;
            owner = recipient;
        } else {
            /*
             * Outgoing:
             * sender = Communik8 / Zoom owner
             * to_member = external person
             */
            owner = sender;
            external = recipient;
        }

        const client = await db.connect();

        try {
            await client.query('BEGIN');

            /*
             * Only replace an empty participant snapshot.
             * Do not overwrite a proper Zoom snapshot.
             */
            const existingResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM zoom_sms_participants
                    WHERE sms_session_id = $1
                    `,
                    [smsSessionId]
                );

            const existingCount =
                Number(
                    existingResult.rows[0]?.count ?? 0
                );

            if (existingCount > 0) {
                await client.query('ROLLBACK');

                return {
                    recovered: false,
                    participantsProcessed:
                        existingCount
                };
            }

            await client.query(
                `
                INSERT INTO zoom_sms_participants (
                    sms_session_id,
                    owner_type,
                    owner_id,
                    is_session_owner,
                    phone_number,
                    display_name
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    TRUE,
                    $4,
                    NULL
                )
                `,
                [
                    smsSessionId,
                    owner.owner?.type ?? null,
                    owner.owner?.id ?? null,
                    owner.phone_number
                ]
            );

            await client.query(
                `
                INSERT INTO zoom_sms_participants (
                    sms_session_id,
                    owner_type,
                    owner_id,
                    is_session_owner,
                    phone_number,
                    display_name
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    FALSE,
                    $4,
                    NULL
                )
                `,
                [
                    smsSessionId,
                    external.owner?.type ?? null,
                    external.owner?.id ?? null,
                    external.phone_number
                ]
            );

            await client.query('COMMIT');

            console.log(
                '[ZOOM SMS PARTICIPANTS RECOVERED FROM MESSAGE]',
                {
                    installationId,
                    smsSessionId,
                    participantsProcessed: 2
                }
            );

            return {
                recovered: true,
                participantsProcessed: 2
            };
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // Preserve original error.
            }

            throw error;
        } finally {
            client.release();
        }
    }

    console.log(
        '[ZOOM SMS PARTICIPANT RECOVERY NOT POSSIBLE]',
        {
            installationId,
            smsSessionId
        }
    );

    return {
        recovered: false,
        participantsProcessed: 0
    };
}

type SmsRecoveredParty = {
    phone_number?: string;
    owner?: {
        type?: string;
        id?: string;
    };
};

function asSmsParty(
    value: unknown
): SmsRecoveredParty | null {
    let parsed = value;

    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }

    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        return null;
    }

    return parsed as SmsRecoveredParty;
}

function asSmsPartyArray(
    value: unknown
): SmsRecoveredParty[] {
    let parsed = value;

    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return [];
        }
    }

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed
        .map(item => asSmsParty(item))
        .filter(
            (
                item
            ): item is SmsRecoveredParty =>
                item !== null
        );
}

export async function cleanupEmptyWebhookSmsSession(
    installationId: string,
    smsSessionId: number
): Promise<boolean> {
    const result = await db.query(
        `
        DELETE FROM zoom_sms_sessions AS session
        WHERE session.id = $1
          AND session.installation_id = $2
          AND session.sync_token IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM zoom_sms_messages AS message
              WHERE message.sms_session_id = session.id
          )
        RETURNING session.id
        `,
        [
            smsSessionId,
            installationId
        ]
    );

    const deleted = result.rowCount === 1;

    if (deleted) {
        console.log(
            '[ZOOM SMS EMPTY SESSION CLEANED]',
            {
                installationId,
                smsSessionId
            }
        );
    }

    return deleted;
}