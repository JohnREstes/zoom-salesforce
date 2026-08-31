import { db } from './db.js';
import { syncSmsSession } from './zoomPhoneService.js';
import {
    findSalesforceContactsByPhone
} from './salesforceContactService.js';

type ZoomSmsMessage = {
    sender?: unknown;
    direction?: string;
    message?: string;
    attachments?: unknown;
    to_members?: unknown;
    message_id?: string;
    message_type?: string;
    date_time?: string;
};

type ZoomSmsSyncResponse = {
    sms_histories?: ZoomSmsMessage[];
    sync_token?: string;
};

export async function syncSmsMessagesForSession(
    installationId: string,
    smsSessionId: number
): Promise<{
    messagesProcessed: number;
    syncTokenSaved: boolean;
}> {
    const sessionResult = await db.query(
        `
        SELECT
            id,
            zoom_session_id,
            sync_token,
            salesforce_contact_id,
            salesforce_account_id
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

    const zoomSessionId =
        sessionResult.rows[0].zoom_session_id;

    const existingSyncToken =
        sessionResult.rows[0].sync_token;

    const existingSalesforceContactId =
        sessionResult.rows[0].salesforce_contact_id;

    const response =
        await syncSmsSession(
            installationId,
            zoomSessionId,
            existingSyncToken
                ? {
                    syncType: 'ISync',
                    count: 100,
                    syncToken: existingSyncToken
                }
                : {
                    syncType: 'FSync',
                    count: 100
                }
        ) as ZoomSmsSyncResponse;

    const messages =
        Array.isArray(response.sms_histories)
            ? response.sms_histories
            : [];

    let salesforceMatch:
        {
            contactId: string;
            accountId: string | null;
        } | null = null;

    if (!existingSalesforceContactId) {
        const messageWithExternalPhone =
            messages.find(
                message =>
                    Boolean(
                        getExternalPhoneNumber(
                            message
                        )
                    )
            );

        if (messageWithExternalPhone) {
            const externalPhoneNumber =
                getExternalPhoneNumber(
                    messageWithExternalPhone
                );

            if (externalPhoneNumber) {
                const matches =
                    await findSalesforceContactsByPhone(
                        installationId,
                        externalPhoneNumber
                    );

                console.log(
                    '[SALESFORCE SMS SESSION MATCH]',
                    {
                        installationId,
                        smsSessionId,
                        matchCount:
                            matches.length,
                        contactIds:
                            matches.map(
                                match => match.id
                            ),
                        accountIds:
                            matches
                                .map(
                                    match =>
                                        match.accountId
                                )
                                .filter(Boolean)
                    }
                );

                if (matches.length === 1) {
                    salesforceMatch = {
                        contactId:
                            matches[0].id,
                        accountId:
                            matches[0].accountId
                    };
                }
            }
        }
    }

    const client = await db.connect();

    let messagesProcessed = 0;

    try {
        await client.query('BEGIN');

        for (const message of messages) {
            if (!message.message_id) {
                continue;
            }

            await client.query(
                `
                INSERT INTO zoom_sms_messages (
                    sms_session_id,
                    zoom_message_id,
                    direction,
                    message_type,
                    message_body,
                    message_date_time,
                    sender,
                    to_members,
                    attachments
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9
                )
                ON CONFLICT (
                    sms_session_id,
                    zoom_message_id
                )
                DO UPDATE SET
                    direction =
                        EXCLUDED.direction,
                    message_type =
                        EXCLUDED.message_type,
                    message_body =
                        EXCLUDED.message_body,
                    message_date_time =
                        EXCLUDED.message_date_time,
                    sender =
                        EXCLUDED.sender,
                    to_members =
                        EXCLUDED.to_members,
                    attachments =
                        EXCLUDED.attachments,
                    updated_at = NOW()
                `,
                [
                    smsSessionId,
                    message.message_id,
                    message.direction ?? null,
                    message.message_type ?? null,
                    message.message ?? null,
                    message.date_time
                        ? new Date(message.date_time)
                        : null,
                    message.sender
                        ? JSON.stringify(message.sender)
                        : null,
                    message.to_members
                        ? JSON.stringify(message.to_members)
                        : null,
                    message.attachments
                        ? JSON.stringify(message.attachments)
                        : null
                ]
            );

            messagesProcessed += 1;
        }

        if (salesforceMatch) {
            await client.query(
                `
                UPDATE zoom_sms_sessions
                SET
                    salesforce_contact_id = $1,
                    salesforce_account_id = $2,
                    salesforce_matched_at = NOW(),
                    updated_at = NOW()
                WHERE id = $3
                AND installation_id = $4
                `,
                [
                    salesforceMatch.contactId,
                    salesforceMatch.accountId,
                    smsSessionId,
                    installationId
                ]
            );

            console.log(
                '[SALESFORCE SMS SESSION MATCH SAVED]',
                {
                    installationId,
                    smsSessionId,
                    contactId:
                        salesforceMatch.contactId,
                    accountId:
                        salesforceMatch.accountId
                }
            );
        }

        if (response.sync_token) {
            await client.query(
                `
                UPDATE zoom_sms_sessions
                SET
                    sync_token = $1,
                    updated_at = NOW()
                WHERE id = $2
                `,
                [
                    response.sync_token,
                    smsSessionId
                ]
            );
        }

        await client.query('COMMIT');

        console.log('[ZOOM SMS MESSAGE SYNC SUCCESS]', {
            installationId,
            smsSessionId,
            syncType:
                existingSyncToken
                    ? 'ISync'
                    : 'FSync',
            messagesProcessed,
            syncTokenSaved:
                Boolean(response.sync_token)
        });

        return {
            messagesProcessed,
            syncTokenSaved:
                Boolean(response.sync_token)
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

type ZoomSmsParty = {
    phone_number?: string;
};

function getExternalPhoneNumber(
    message: ZoomSmsMessage
): string | null {
    const direction =
        message.direction?.toLowerCase();

    if (direction === 'in') {
        const sender =
            message.sender as ZoomSmsParty | undefined;

        return sender?.phone_number ?? null;
    }

    if (direction === 'out') {
        const toMembers =
            Array.isArray(message.to_members)
                ? message.to_members as ZoomSmsParty[]
                : [];

        return toMembers[0]?.phone_number ?? null;
    }

    return null;
}