import { db } from './db.js';

function phoneVariants(phone: string): string[] {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return [];
    const values = new Set<string>([digits]);
    if (digits.length === 10) values.add(`1${digits}`);
    if (digits.length === 11 && digits.startsWith('1')) {
        values.add(digits.slice(1));
    }
    return [...values];
}

export async function saveSalesforceContactPhoneMappings(
    installationId: string,
    contactId: string,
    accountId: string | null,
    phones: string[]
): Promise<number> {
    const normalizedPhones = [
        ...new Set(phones.flatMap(phoneVariants))
    ];

    let saved = 0;

    for (const normalizedPhone of normalizedPhones) {
        const result = await db.query(
            `
            INSERT INTO salesforce_contact_phone_mappings (
                installation_id,
                normalized_phone,
                salesforce_contact_id,
                salesforce_account_id,
                source,
                verified_at,
                last_seen_at
            )
            VALUES ($1, $2, $3, $4, 'SALESFORCE_CONTACT_DISCOVERY', NOW(), NOW())
            ON CONFLICT (
                installation_id,
                normalized_phone,
                salesforce_contact_id
            )
            DO UPDATE SET
                salesforce_account_id = EXCLUDED.salesforce_account_id,
                verified_at = NOW(),
                last_seen_at = NOW(),
                updated_at = NOW()
            RETURNING id
            `,
            [installationId, normalizedPhone, contactId, accountId]
        );
        if (result.rowCount === 1) saved++;
    }

    return saved;
}

export async function applyDurableContactMappingToSmsSession(
    installationId: string,
    smsSessionId: number
): Promise<{
    matched: boolean;
    ambiguous: boolean;
    contactId: string | null;
    accountId: string | null;
}> {
    const candidates = await db.query<{
        salesforce_contact_id: string;
        salesforce_account_id: string | null;
    }>(
        `
        WITH external_phones AS (
            SELECT DISTINCT
                regexp_replace(
                    COALESCE(phone_number, ''),
                    '[^0-9]', '', 'g'
                ) AS normalized_phone
            FROM zoom_sms_participants
            WHERE sms_session_id = $1
              AND is_session_owner = FALSE
              AND phone_number IS NOT NULL
        )
        SELECT DISTINCT
            m.salesforce_contact_id,
            m.salesforce_account_id
        FROM external_phones ep
        INNER JOIN salesforce_contact_phone_mappings m
            ON m.installation_id = $2
           AND m.normalized_phone = ep.normalized_phone
        WHERE ep.normalized_phone <> ''
        ORDER BY m.salesforce_contact_id
        LIMIT 2
        `,
        [smsSessionId, installationId]
    );

    if (candidates.rowCount !== 1) {
        return {
            matched: false,
            ambiguous: (candidates.rowCount ?? 0) > 1,
            contactId: null,
            accountId: null
        };
    }

    const candidate = candidates.rows[0];

    const updated = await db.query(
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
        RETURNING id
        `,
        [
            candidate.salesforce_contact_id,
            candidate.salesforce_account_id,
            smsSessionId,
            installationId
        ]
    );

    if (updated.rowCount !== 1) {
        return {
            matched: false,
            ambiguous: false,
            contactId: null,
            accountId: null
        };
    }

    return {
        matched: true,
        ambiguous: false,
        contactId: candidate.salesforce_contact_id,
        accountId: candidate.salesforce_account_id
    };
}
