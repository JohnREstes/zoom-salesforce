import { db } from './db.js';
import {
    getSalesforceContactById
} from './salesforceContactService.js';
import {
    syncSmsMessagesForSession
} from './zoomSmsMessageSyncService.js';

type CandidateSessionRow = {
    id: number;
    salesforce_contact_id: string | null;
};

export type SalesforceSmsHistoryDiscoveryResult = {
    found: boolean;
    smsSessionId: number | null;
    matched: boolean;
    synced: boolean;
};

function getPhoneVariants(
    phoneNumber: string
): string[] {
    const digits =
        phoneNumber.replace(/\D/g, '');

    if (!digits) {
        return [];
    }

    const variants = new Set<string>();

    variants.add(digits);

    if (digits.length === 10) {
        variants.add(`1${digits}`);
    }

    if (
        digits.length === 11 &&
        digits.startsWith('1')
    ) {
        variants.add(digits.slice(1));
    }

    return [...variants];
}

export async function discoverSalesforceSmsHistory(
    installationId: string,
    salesforceUserId: string,
    contactId: string
): Promise<SalesforceSmsHistoryDiscoveryResult> {
    const contact =
        await getSalesforceContactById(
            installationId,
            contactId
        );

    if (!contact) {
        return {
            found: false,
            smsSessionId: null,
            matched: false,
            synced: false
        };
    }

    const rawPhones = [
        contact.mobilePhone,
        contact.phone,
        contact.otherPhone,
        contact.homePhone
    ].filter(
        (phone): phone is string =>
            typeof phone === 'string' &&
            phone.trim().length > 0
    );

    const phoneVariants =
        [
            ...new Set(
                rawPhones.flatMap(
                    phone =>
                        getPhoneVariants(phone)
                )
            )
        ];

    if (phoneVariants.length === 0) {
        return {
            found: false,
            smsSessionId: null,
            matched: false,
            synced: false
        };
    }

    /*
     * Search only Communik8's local participant index.
     * Opening a Salesforce Contact does not call Zoom unless
     * we find exactly one candidate session locally.
     */
    const candidateResult =
        await db.query<CandidateSessionRow>(
            `
                WITH authorized_user AS (
                    SELECT zoom_user_id
                    FROM communic8_users
                    WHERE installation_id = $1
                    AND salesforce_user_id = $2
                    AND is_active = TRUE
                    AND zoom_user_id IS NOT NULL
                    LIMIT 1
                )
                SELECT DISTINCT
                    s.id,
                    s.salesforce_contact_id
                FROM zoom_sms_sessions s
                INNER JOIN authorized_user au
                    ON TRUE
                INNER JOIN zoom_sms_participants owner_participant
                    ON owner_participant.sms_session_id = s.id
                AND owner_participant.is_session_owner = TRUE
                AND owner_participant.owner_id = au.zoom_user_id
                INNER JOIN zoom_sms_participants external_participant
                    ON external_participant.sms_session_id = s.id
                AND external_participant.is_session_owner = FALSE
                WHERE s.installation_id = $1
                AND regexp_replace(
                        COALESCE(
                            external_participant.phone_number,
                            ''
                        ),
                        '[^0-9]',
                        '',
                        'g'
                    ) = ANY($3::text[])
                ORDER BY s.id DESC
                LIMIT 2
            `,
            [
                installationId,
                salesforceUserId,
                phoneVariants
            ]
        );

    /*
     * Zero candidates: nothing useful exists locally.
     * More than one: do not guess which conversation belongs
     * to the Contact.
     */
    if (candidateResult.rowCount !== 1) {
        console.log(
            '[SALESFORCE SMS HISTORY LOCAL DISCOVERY]',
            {
                installationId,
                contactId,
                candidateCount:
                    candidateResult.rowCount ?? 0,
                matched: false
            }
        );

        return {
            found:
                (candidateResult.rowCount ?? 0) > 0,
            smsSessionId: null,
            matched: false,
            synced: false
        };
    }

    const candidate =
        candidateResult.rows[0];

    /*
     * Never silently reassign a session that is already
     * associated with a different Salesforce Contact.
     */
    if (
        candidate.salesforce_contact_id &&
        candidate.salesforce_contact_id !== contactId
    ) {
        console.warn(
            '[SALESFORCE SMS HISTORY MATCH CONFLICT]',
            {
                installationId,
                contactId,
                smsSessionId: candidate.id
            }
        );

        return {
            found: true,
            smsSessionId: candidate.id,
            matched: false,
            synced: false
        };
    }

    const updateResult =
        await db.query(
            `
                UPDATE zoom_sms_sessions AS s
                SET
                    salesforce_contact_id = $1,
                    salesforce_account_id = $2,
                    salesforce_matched_at = NOW(),
                    updated_at = NOW()
                WHERE s.id = $3
                AND s.installation_id = $4
                AND (
                        s.salesforce_contact_id IS NULL
                        OR s.salesforce_contact_id = $1
                    )
                AND EXISTS (
                        SELECT 1
                        FROM zoom_sms_participants owner_participant
                        INNER JOIN communic8_users cu
                            ON cu.installation_id = $4
                        AND cu.salesforce_user_id = $5
                        AND cu.is_active = TRUE
                        AND cu.zoom_user_id =
                            owner_participant.owner_id
                        WHERE owner_participant.sms_session_id = s.id
                        AND owner_participant.is_session_owner = TRUE
                        AND owner_participant.owner_type = 'user'
                    )
                RETURNING s.id
            `,
            [
                contactId,
                contact.accountId,
                candidate.id,
                installationId,
                salesforceUserId
            ]
        );

    if (updateResult.rowCount !== 1) {
        return {
            found: true,
            smsSessionId: candidate.id,
            matched: false,
            synced: false
        };
    }

    /*
     * A candidate exists, so this is a targeted Zoom request,
     * not broad polling. FSync hydrates the conversation's
     * available history.
     */
    await syncSmsMessagesForSession(
        installationId,
        candidate.id,
        {
            forceFullSync: true
        }
    );

    console.log(
        '[SALESFORCE SMS HISTORY DISCOVERED]',
        {
            installationId,
            contactId,
            smsSessionId: candidate.id
        }
    );

    return {
        found: true,
        smsSessionId: candidate.id,
        matched: true,
        synced: true
    };
}