import { db } from './db.js';

import {
    COMMUNIK8_CAPABILITIES,
    hasCommunik8UserCapability
} from './communik8CapabilityService.js';

import {
    syncViewAllMessagesCapabilityFromSalesforce
} from './salesforceCapabilitySyncService.js';

export type CorporateSmsMessage = {
    id: string;
    zoomMessageId: string;
    direction: string | null;
    messageType: string | null;
    body: string | null;
    dateTime: string | null;
    attachments: unknown;
};

export type CorporateSmsConversationOwner = {
    communic8UserId: number;
    salesforceUserId: string | null;
    salesforceName: string | null;
    salesforceEmail: string | null;
    zoomUserId: string;
    zoomEmail: string | null;
    zoomPhoneNumber: string | null;
    isCurrentUser: boolean;
};

export type CorporateSmsConversation = {
    smsSessionId: string;
    zoomSessionId: string;
    lastAccessTime: string | null;
    salesforceContactId: string | null;
    salesforceAccountId: string | null;
    owner: CorporateSmsConversationOwner;
    messages: CorporateSmsMessage[];
};

export type CorporateConversationLookupOptions = {
    sessionLimit?: number;
    messageLimitPerSession?: number;
};

type RequestingUserRow = {
    id: number;
    is_communik8_enabled: boolean;
};

type CorporateConversationRow = {
    sms_session_id: string;
    zoom_session_id: string;
    last_access_time: Date | string | null;
    salesforce_contact_id: string | null;
    salesforce_account_id: string | null;

    owner_communic8_user_id: number;
    owner_salesforce_user_id: string | null;
    owner_salesforce_name: string | null;
    owner_salesforce_email: string | null;
    owner_zoom_user_id: string;
    owner_zoom_email: string | null;
    owner_zoom_phone_number: string | null;

    message_id: string | null;
    zoom_message_id: string | null;
    direction: string | null;
    message_type: string | null;
    message_body: string | null;
    message_date_time: Date | string | null;
    attachments: unknown;
};

export class CorporateMessageAccessDeniedError extends Error {
    constructor() {
        super('Communik8 corporate message access is not authorized');
        this.name = 'CorporateMessageAccessDeniedError';
    }
}

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

/**
 * Resolve and authorize the Salesforce user requesting organization-wide
 * history.
 *
 * The authorization sequence is deliberately fail-closed:
 *
 *   Salesforce user
 *       -> exact Communik8 user mapping
 *       -> normal Communik8 user entitlement
 *       -> synchronize Salesforce Custom Permission
 *       -> durable VIEW_ALL_MESSAGES capability
 *
 * This means Salesforce administration controls who receives the elevated
 * user grant, while the backend still enforces its own durable capability.
 */
async function getAuthorizedCorporateViewer(
    installationId: string,
    salesforceUserId: string
): Promise<number> {
    const result =
        await db.query<RequestingUserRow>(
            `
            SELECT
                id,
                is_communik8_enabled
            FROM communic8_users
            WHERE installation_id = $1
              AND salesforce_user_id = $2
            LIMIT 2
            `,
            [
                installationId,
                salesforceUserId
            ]
        );

    if (
        result.rowCount !== 1 ||
        result.rows[0]?.is_communik8_enabled !== true
    ) {
        throw new CorporateMessageAccessDeniedError();
    }

    const communic8UserId =
        result.rows[0].id;

    /*
     * Salesforce is the administrative source of truth for this user's
     * elevated access. Synchronize before every corporate-history read so
     * permission assignment/removal takes effect without a separate admin
     * job or manual database operation.
     *
     * If Salesforce cannot be checked successfully, the sync service throws
     * and access is not granted from stale UI state.
     */
    await syncViewAllMessagesCapabilityFromSalesforce(
        installationId,
        salesforceUserId,
        communic8UserId
    );

    /*
     * Re-check the backend capability after synchronization.
     * This keeps the actual data-access decision inside Communik8.
     */
    const allowed =
        await hasCommunik8UserCapability(
            installationId,
            communic8UserId,
            COMMUNIK8_CAPABILITIES.VIEW_ALL_MESSAGES
        );

    if (!allowed) {
        throw new CorporateMessageAccessDeniedError();
    }

    return communic8UserId;
}

/**
 * Returns all Communik8-owned SMS sessions associated with one Salesforce
 * Contact for an authorized corporate viewer.
 *
 * IMPORTANT:
 * - This does NOT change the existing personal-conversation query.
 * - It intentionally includes historical sessions owned by inactive or
 *   currently-unlicensed users so authorized corporate users retain business
 *   continuity after employee changes.
 * - Every session includes its durable owner identity so the UI can keep
 *   employees' conversations visually separated.
 */
export async function getCorporateSmsConversationsForContact(
    installationId: string,
    salesforceUserId: string,
    salesforceContactId: string,
    options: CorporateConversationLookupOptions = {}
): Promise<CorporateSmsConversation[]> {
    const requestingCommunik8UserId =
        await getAuthorizedCorporateViewer(
            installationId,
            salesforceUserId
        );

    const sessionLimit =
        clampInteger(
            options.sessionLimit,
            50,
            1,
            200
        );

    const messageLimitPerSession =
        clampInteger(
            options.messageLimitPerSession,
            200,
            1,
            500
        );

    const result =
        await db.query<CorporateConversationRow>(
            `
            WITH selected_sessions AS (
                SELECT
                    s.id,
                    s.zoom_session_id,
                    s.last_access_time,
                    s.salesforce_contact_id,
                    s.salesforce_account_id,

                    cu.id
                        AS owner_communic8_user_id,
                    cu.salesforce_user_id
                        AS owner_salesforce_user_id,
                    cu.salesforce_name
                        AS owner_salesforce_name,
                    cu.salesforce_email
                        AS owner_salesforce_email,
                    cu.zoom_user_id
                        AS owner_zoom_user_id,
                    cu.zoom_email
                        AS owner_zoom_email,
                    cu.zoom_phone_number
                        AS owner_zoom_phone_number

                FROM zoom_sms_sessions s

                INNER JOIN LATERAL (
                    SELECT
                        p.owner_id
                    FROM zoom_sms_participants p
                    WHERE p.sms_session_id = s.id
                      AND p.is_session_owner = TRUE
                      AND p.owner_type = 'user'
                      AND p.owner_id IS NOT NULL
                    ORDER BY p.id ASC
                    LIMIT 1
                ) owner_participant
                    ON TRUE

                INNER JOIN communic8_users cu
                    ON cu.installation_id = s.installation_id
                   AND cu.zoom_user_id =
                       owner_participant.owner_id

                WHERE s.installation_id = $1
                  AND s.salesforce_contact_id = $2

                ORDER BY
                    s.last_access_time DESC NULLS LAST,
                    s.id DESC

                LIMIT $3
            )

            SELECT
                s.id AS sms_session_id,
                s.zoom_session_id,
                s.last_access_time,
                s.salesforce_contact_id,
                s.salesforce_account_id,

                s.owner_communic8_user_id,
                s.owner_salesforce_user_id,
                s.owner_salesforce_name,
                s.owner_salesforce_email,
                s.owner_zoom_user_id,
                s.owner_zoom_email,
                s.owner_zoom_phone_number,

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
                LIMIT $4
            ) m
                ON TRUE

            ORDER BY
                s.last_access_time DESC NULLS LAST,
                s.id DESC,
                m.message_date_time ASC NULLS LAST,
                m.id ASC
            `,
            [
                installationId,
                salesforceContactId,
                sessionLimit,
                messageLimitPerSession
            ]
        );

    const conversations =
        new Map<string, CorporateSmsConversation>();

    for (const row of result.rows) {
        let conversation =
            conversations.get(row.sms_session_id);

        if (!conversation) {
            conversation = {
                smsSessionId:
                    row.sms_session_id,

                zoomSessionId:
                    row.zoom_session_id,

                lastAccessTime:
                    toIsoString(row.last_access_time),

                salesforceContactId:
                    row.salesforce_contact_id,

                salesforceAccountId:
                    row.salesforce_account_id,

                owner: {
                    communic8UserId:
                        row.owner_communic8_user_id,

                    salesforceUserId:
                        row.owner_salesforce_user_id,

                    salesforceName:
                        row.owner_salesforce_name,

                    salesforceEmail:
                        row.owner_salesforce_email,

                    zoomUserId:
                        row.owner_zoom_user_id,

                    zoomEmail:
                        row.owner_zoom_email,

                    zoomPhoneNumber:
                        row.owner_zoom_phone_number,

                    isCurrentUser:
                        row.owner_communic8_user_id ===
                        requestingCommunik8UserId
                },

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
                id:
                    row.message_id,

                zoomMessageId:
                    row.zoom_message_id,

                direction:
                    row.direction,

                messageType:
                    row.message_type,

                body:
                    row.message_body,

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

    return Array.from(
        conversations.values()
    );
}
