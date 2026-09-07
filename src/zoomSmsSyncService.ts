import { db } from './db.js';
import {
    getSmsSessions,
    getUserSmsSessions
} from './zoomPhoneService.js';


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

export async function syncSmsSessionsForUser(
    installationId: string,
    zoomUserId: string
): Promise<{
    pagesProcessed: number;
    sessionsProcessed: number;
    participantsProcessed: number;
}> {
    if (!zoomUserId) {
        throw new Error(
            'Zoom user ID is required for user SMS session sync'
        );
    }

    let nextPageToken: string | undefined;
    let pagesProcessed = 0;
    let sessionsProcessed = 0;
    let participantsProcessed = 0;

    do {
        const response =
            await getUserSmsSessions(
                installationId,
                zoomUserId,
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

            /*
             * Defense in depth:
             * A user-scoped Zoom response should contain sessions
             * belonging to the requested Zoom user. Verify that
             * relationship before persisting anything.
             */
            const ownerParticipants =
                Array.isArray(session.participants)
                    ? session.participants.filter(
                        participant =>
                            participant.is_session_owner === true &&
                            participant.owner?.type === 'user' &&
                            participant.owner?.id === zoomUserId
                    )
                    : [];

            if (ownerParticipants.length !== 1) {
                console.warn(
                    '[ZOOM USER SMS SESSION OWNER MISMATCH]',
                    {
                        installationId,
                        hasZoomUserId: true,
                        hasSessionId: true,
                        matchingOwnerCount:
                            ownerParticipants.length
                    }
                );

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
                 * This response came from the user-scoped Zoom
                 * endpoint and passed the owner check above, so
                 * Zoom is authoritative for this snapshot.
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
                            participant.is_session_owner ??
                                false,
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

    console.log(
        '[ZOOM USER SMS SESSION SYNC SUCCESS]',
        {
            installationId,
            hasZoomUserId: true,
            pagesProcessed,
            sessionsProcessed,
            participantsProcessed
        }
    );

    return {
        pagesProcessed,
        sessionsProcessed,
        participantsProcessed
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

export async function backfillSmsSessionOwnersFromMessages(
    installationId: string
): Promise<{
    candidates: number;
    repaired: number;
    ambiguous: number;
    unmapped: number;
}> {
    const result = await db.query<{
        sms_session_id: string;
        zoom_owner_id: string | null;
        owner_count: string;
        mapped_owner_count: string;
    }>(
        `
            WITH candidate_owners AS (

                /*
                 * Outbound:
                 * sender.owner is the internal Zoom user.
                 */
                SELECT DISTINCT
                    s.id AS sms_session_id,
                    m.sender -> 'owner' ->> 'id'
                        AS zoom_owner_id
                FROM zoom_sms_sessions s
                INNER JOIN zoom_sms_messages m
                    ON m.sms_session_id = s.id
                WHERE s.installation_id = $1
                  AND LOWER(m.direction) = 'out'
                  AND jsonb_typeof(
                        m.sender -> 'owner'
                      ) = 'object'
                  AND m.sender -> 'owner' ->> 'id'
                        IS NOT NULL
                  AND NOT EXISTS (
                        SELECT 1
                        FROM zoom_sms_participants p
                        WHERE p.sms_session_id = s.id
                          AND p.is_session_owner = TRUE
                    )

                UNION

                /*
                 * Inbound:
                 * to_member.owner is the internal Zoom user.
                 */
                SELECT DISTINCT
                    s.id AS sms_session_id,
                    tm.member -> 'owner' ->> 'id'
                        AS zoom_owner_id
                FROM zoom_sms_sessions s
                INNER JOIN zoom_sms_messages m
                    ON m.sms_session_id = s.id
                CROSS JOIN LATERAL
                    jsonb_array_elements(m.to_members)
                    AS tm(member)
                WHERE s.installation_id = $1
                  AND LOWER(m.direction) = 'in'
                  AND jsonb_typeof(m.to_members) = 'array'
                  AND jsonb_typeof(
                        tm.member -> 'owner'
                      ) = 'object'
                  AND tm.member -> 'owner' ->> 'id'
                        IS NOT NULL
                  AND NOT EXISTS (
                        SELECT 1
                        FROM zoom_sms_participants p
                        WHERE p.sms_session_id = s.id
                          AND p.is_session_owner = TRUE
                    )
            ),
            per_session AS (
                SELECT
                    sms_session_id,
                    COUNT(DISTINCT zoom_owner_id)
                        AS owner_count,
                    MIN(zoom_owner_id)
                        AS zoom_owner_id
                FROM candidate_owners
                GROUP BY sms_session_id
            ),
            classified AS (
                SELECT
                    ps.sms_session_id,
                    ps.zoom_owner_id,
                    ps.owner_count,
                    CASE
                        WHEN ps.owner_count = 1
                         AND EXISTS (
                                SELECT 1
                                FROM communic8_users cu
                                WHERE cu.installation_id = $1
                                  AND cu.zoom_user_id =
                                      ps.zoom_owner_id
                            )
                        THEN 1
                        ELSE 0
                    END AS mapped_owner_count
                FROM per_session ps
            )
            SELECT
                sms_session_id::text,
                zoom_owner_id,
                owner_count::text,
                mapped_owner_count::text
            FROM classified
        `,
        [installationId]
    );

    let repaired = 0;
    let ambiguous = 0;
    let unmapped = 0;

    for (const row of result.rows) {
        const ownerCount = Number(row.owner_count);
        const mappedOwnerCount =
            Number(row.mapped_owner_count);

        if (ownerCount !== 1) {
            ambiguous += 1;
            continue;
        }

        if (
            mappedOwnerCount !== 1 ||
            !row.zoom_owner_id
        ) {
            unmapped += 1;
            continue;
        }

        const updateResult = await db.query(
            `
                INSERT INTO zoom_sms_participants (
                    sms_session_id,
                    owner_type,
                    owner_id,
                    is_session_owner,
                    phone_number,
                    display_name
                )
                SELECT
                    $1,
                    'user',
                    $2,
                    TRUE,
                    NULL,
                    NULL
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM zoom_sms_participants p
                    WHERE p.sms_session_id = $1
                      AND p.is_session_owner = TRUE
                )
                RETURNING id
            `,
            [
                Number(row.sms_session_id),
                row.zoom_owner_id
            ]
        );

        if (updateResult.rowCount === 1) {
            repaired += 1;
        }
    }

    console.log(
        '[ZOOM SMS HISTORICAL OWNER BACKFILL]',
        {
            installationId,
            candidates: result.rows.length,
            repaired,
            ambiguous,
            unmapped
        }
    );

    return {
        candidates: result.rows.length,
        repaired,
        ambiguous,
        unmapped
    };
}

export async function backfillSmsSessionParticipantDetailsFromMessages(
    installationId: string
): Promise<{
    candidates: number;
    repaired: number;
    ambiguous: number;
}> {
    const result = await db.query<{
        sms_session_id: string;
        owner_id: string;
        owner_phone: string | null;
        external_phone: string | null;
        owner_phone_count: string;
        external_phone_count: string;
    }>(
        `
            WITH authoritative_sessions AS (
                SELECT
                    s.id AS sms_session_id,
                    p.owner_id
                FROM zoom_sms_sessions s
                INNER JOIN zoom_sms_participants p
                    ON p.sms_session_id = s.id
                   AND p.is_session_owner = TRUE
                   AND p.owner_type = 'user'
                   AND p.owner_id IS NOT NULL
                INNER JOIN communic8_users cu
                    ON cu.installation_id = s.installation_id
                   AND cu.zoom_user_id = p.owner_id
                WHERE s.installation_id = $1
            ),

            candidate_pairs AS (

                /*
                 * Outbound:
                 * sender = internal owner
                 * to_member = external party
                 */
                SELECT
                    a.sms_session_id,
                    a.owner_id,
                    m.sender ->> 'phone_number'
                        AS owner_phone,
                    tm.member ->> 'phone_number'
                        AS external_phone
                FROM authoritative_sessions a
                INNER JOIN zoom_sms_messages m
                    ON m.sms_session_id = a.sms_session_id
                CROSS JOIN LATERAL
                    jsonb_array_elements(m.to_members)
                    AS tm(member)
                WHERE LOWER(m.direction) = 'out'
                  AND jsonb_typeof(m.to_members) = 'array'
                  AND m.sender -> 'owner' ->> 'id'
                        = a.owner_id
                  AND m.sender ->> 'phone_number'
                        IS NOT NULL
                  AND tm.member ->> 'phone_number'
                        IS NOT NULL

                UNION ALL

                /*
                 * Inbound:
                 * sender = external party
                 * to_member = internal owner
                 */
                SELECT
                    a.sms_session_id,
                    a.owner_id,
                    tm.member ->> 'phone_number'
                        AS owner_phone,
                    m.sender ->> 'phone_number'
                        AS external_phone
                FROM authoritative_sessions a
                INNER JOIN zoom_sms_messages m
                    ON m.sms_session_id = a.sms_session_id
                CROSS JOIN LATERAL
                    jsonb_array_elements(m.to_members)
                    AS tm(member)
                WHERE LOWER(m.direction) = 'in'
                  AND jsonb_typeof(m.to_members) = 'array'
                  AND tm.member -> 'owner' ->> 'id'
                        = a.owner_id
                  AND tm.member ->> 'phone_number'
                        IS NOT NULL
                  AND m.sender ->> 'phone_number'
                        IS NOT NULL
            ),

            per_session AS (
                SELECT
                    sms_session_id,
                    MIN(owner_id) AS owner_id,

                    COUNT(DISTINCT owner_phone)
                        AS owner_phone_count,

                    MIN(owner_phone)
                        AS owner_phone,

                    COUNT(DISTINCT external_phone)
                        AS external_phone_count,

                    MIN(external_phone)
                        AS external_phone

                FROM candidate_pairs
                GROUP BY sms_session_id
            )

            SELECT
                sms_session_id::text,
                owner_id,
                owner_phone,
                external_phone,
                owner_phone_count::text,
                external_phone_count::text
            FROM per_session
        `,
        [installationId]
    );

    let repaired = 0;
    let ambiguous = 0;

    for (const row of result.rows) {
        if (
            Number(row.owner_phone_count) !== 1 ||
            Number(row.external_phone_count) !== 1 ||
            !row.owner_phone ||
            !row.external_phone
        ) {
            ambiguous += 1;
            continue;
        }

        const client = await db.connect();

        try {
            await client.query('BEGIN');

            /*
             * Fill the authoritative owner's phone number,
             * but never change its owner identity.
             */
            await client.query(
                `
                    UPDATE zoom_sms_participants
                    SET phone_number = COALESCE(
                        phone_number,
                        $1
                    )
                    WHERE sms_session_id = $2
                      AND is_session_owner = TRUE
                      AND owner_type = 'user'
                      AND owner_id = $3
                `,
                [
                    row.owner_phone,
                    Number(row.sms_session_id),
                    row.owner_id
                ]
            );

            /*
             * Add the external participant only when one
             * does not already exist.
             */
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
                    SELECT
                        $1::bigint,
                        NULL,
                        NULL,
                        FALSE,
                        $2::varchar,
                        NULL
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM zoom_sms_participants p
                        WHERE p.sms_session_id = $1::bigint
                        AND p.is_session_owner = FALSE
                        AND p.phone_number = $2::varchar
                    )
                `,
                [
                    Number(row.sms_session_id),
                    row.external_phone
                ]
            );

            await client.query('COMMIT');

            repaired += 1;
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
        '[ZOOM SMS HISTORICAL PARTICIPANT DETAIL BACKFILL]',
        {
            installationId,
            candidates: result.rows.length,
            repaired,
            ambiguous
        }
    );

    return {
        candidates: result.rows.length,
        repaired,
        ambiguous
    };
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