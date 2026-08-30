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