import { db } from './db.js';

export type SalesforceSmsMessage = {
    id: string;
    zoomMessageId: string;
    direction: string | null;
    messageType: string | null;
    body: string | null;
    dateTime: string | null;
    attachments: unknown;
};

export type SalesforceSmsConversation = {
    smsSessionId: string;
    zoomSessionId: string;
    lastAccessTime: string | null;
    salesforceContactId: string | null;
    salesforceAccountId: string | null;
    messages: SalesforceSmsMessage[];
};

type ConversationLookupOptions = {
    sessionLimit?: number;
    messageLimitPerSession?: number;
};

type ConversationRow = {
    sms_session_id: string;
    zoom_session_id: string;
    last_access_time: Date | string | null;
    salesforce_contact_id: string | null;
    salesforce_account_id: string | null;
    message_id: string | null;
    zoom_message_id: string | null;
    direction: string | null;
    message_type: string | null;
    message_body: string | null;
    message_date_time: Date | string | null;
    attachments: unknown;
};

function clampInteger(
    value: number | undefined,
    defaultValue: number,
    min: number,
    max: number
): number {
    if (!Number.isFinite(value)) {
        return defaultValue;
    }

    return Math.min(
        max,
        Math.max(
            min,
            Math.trunc(value as number)
        )
    );
}

function toIsoString(
    value: Date | string | null
): string | null {
    if (!value) {
        return null;
    }

    const date =
        value instanceof Date
            ? value
            : new Date(value);

    return Number.isNaN(date.getTime())
        ? null
        : date.toISOString();
}

function parseJsonValue(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value ?? null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

async function getSmsConversations(
    installationId: string,
    salesforceUserId: string,
    salesforceField:
        'salesforce_contact_id' |
        'salesforce_account_id',
    salesforceRecordId: string,
    options: ConversationLookupOptions = {}
): Promise<SalesforceSmsConversation[]> {
    const sessionLimit = clampInteger(
        options.sessionLimit,
        25,
        1,
        100
    );

    const messageLimitPerSession = clampInteger(
        options.messageLimitPerSession,
        200,
        1,
        500
    );

    /*
     * The Salesforce field name is restricted to the two literal values
     * above, so it is safe to interpolate into the SQL identifier.
     * All user-controlled values remain parameterized.
     */
    const result = await db.query<ConversationRow>(
        `
        WITH authorized_user AS (
            SELECT zoom_user_id
            FROM communic8_users
            WHERE installation_id = $1
            AND salesforce_user_id = $2
            AND is_active = TRUE
            AND zoom_user_id IS NOT NULL
            LIMIT 1
        ),
        selected_sessions AS (
            SELECT
                s.id,
                s.zoom_session_id,
                s.last_access_time,
                s.salesforce_contact_id,
                s.salesforce_account_id
            FROM zoom_sms_sessions s
            INNER JOIN authorized_user au
                ON TRUE
            WHERE s.installation_id = $1
            AND s.${salesforceField} = $3
            AND EXISTS (
                SELECT 1
                FROM zoom_sms_participants p
                WHERE p.sms_session_id = s.id
                    AND p.is_session_owner = TRUE
                    AND p.owner_type = 'user'
                    AND p.owner_id = au.zoom_user_id
            )
            ORDER BY
                s.last_access_time DESC NULLS LAST,
                s.id DESC
            LIMIT $4
        )
        SELECT
            s.id AS sms_session_id,
            s.zoom_session_id,
            s.last_access_time,
            s.salesforce_contact_id,
            s.salesforce_account_id,
            m.id AS message_id,
            m.zoom_message_id,
            m.direction,
            m.message_type,
            m.message_body,
            m.message_date_time,
            m.attachments
        FROM selected_sessions s
        LEFT JOIN LATERAL (
            SELECT
                id,
                zoom_message_id,
                direction,
                message_type,
                message_body,
                message_date_time,
                attachments
            FROM zoom_sms_messages
            WHERE sms_session_id = s.id
            ORDER BY
                message_date_time DESC NULLS LAST,
                id DESC
            LIMIT $5
        ) m ON TRUE
        ORDER BY
            s.last_access_time DESC NULLS LAST,
            s.id DESC,
            m.message_date_time ASC NULLS LAST,
            m.id ASC
        `,
        [
            installationId,
            salesforceUserId,
            salesforceRecordId,
            sessionLimit,
            messageLimitPerSession
        ]
    );

    const conversations =
        new Map<string, SalesforceSmsConversation>();

    for (const row of result.rows) {
        let conversation =
            conversations.get(row.sms_session_id);

        if (!conversation) {
            conversation = {
                smsSessionId: row.sms_session_id,
                zoomSessionId: row.zoom_session_id,
                lastAccessTime:
                    toIsoString(row.last_access_time),
                salesforceContactId:
                    row.salesforce_contact_id,
                salesforceAccountId:
                    row.salesforce_account_id,
                messages: []
            };

            conversations.set(
                row.sms_session_id,
                conversation
            );
        }

        if (
            row.message_id &&
            row.zoom_message_id
        ) {
            conversation.messages.push({
                id: row.message_id,
                zoomMessageId:
                    row.zoom_message_id,
                direction: row.direction,
                messageType: row.message_type,
                body: row.message_body,
                dateTime:
                    toIsoString(
                        row.message_date_time
                    ),
                attachments:
                    parseJsonValue(
                        row.attachments
                    )
            });
        }
    }

    return Array.from(conversations.values());
}

export async function getSmsConversationsForContact(
    installationId: string,
    salesforceUserId: string,
    salesforceContactId: string,
    options: ConversationLookupOptions = {}
): Promise<SalesforceSmsConversation[]> {
    return getSmsConversations(
        installationId,
        salesforceUserId,
        'salesforce_contact_id',
        salesforceContactId,
        options
    );
}

export async function getSmsConversationsForAccount(
    installationId: string,
    salesforceUserId: string,
    salesforceAccountId: string,
    options: ConversationLookupOptions = {}
): Promise<SalesforceSmsConversation[]> {
    return getSmsConversations(
        installationId,
        salesforceUserId,
        'salesforce_account_id',
        salesforceAccountId,
        options
    );
}