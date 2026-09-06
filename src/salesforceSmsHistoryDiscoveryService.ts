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
            SELECT DISTINCT
                s.id,
                s.salesforce_contact_id
            FROM zoom_sms_sessions s
            INNER JOIN zoom_sms_participants p
                ON p.sms_session_id = s.id
            WHERE s.installation_id = $1
              AND regexp_replace(
                    COALESCE(p.phone_number, ''),
                    '[^0-9]',
                    '',
                    'g'
                  ) = ANY($2::text[])
            ORDER BY s.id DESC
            LIMIT 2
            `,
            [
                installationId,
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

    await db.query(
        `
        UPDATE zoom_sms_sessions
        SET
            salesforce_contact_id = $1,
            salesforce_account_id = $2,
            salesforce_matched_at = NOW(),
            updated_at = NOW()
        WHERE id = $3
          AND installation_id = $4
          AND (
                salesforce_contact_id IS NULL
                OR salesforce_contact_id = $1
              )
        `,
        [
            contactId,
            contact.accountId,
            candidate.id,
            installationId
        ]
    );

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