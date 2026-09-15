import { db } from './db.js';
import { fetchSalesforce } from './salesforceApiService.js';

type SalesforceContactRecord = {
    Id: string;
    AccountId?: string | null;
    Phone?: string | null;
    MobilePhone?: string | null;
    OtherPhone?: string | null;
    HomePhone?: string | null;
};

type SalesforceContactQueryResponse = {
    done: boolean;
    nextRecordsUrl?: string;
    records?: SalesforceContactRecord[];
};

function getPhoneVariants(
    phoneNumber: string
): string[] {
    const digits =
        phoneNumber.replace(/\D/g, '');

    if (!digits) {
        return [];
    }

    const variants =
        new Set<string>([digits]);

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

export async function syncSalesforceContactPhoneDirectory(
    installationId: string
): Promise<{
    contactsProcessed: number;
    contactsWithPhones: number;
    mappingsWritten: number;
    staleMappingsRemoved: number;
}> {
    let contactsProcessed = 0;
    let contactsWithPhones = 0;
    let mappingsWritten = 0;

    /*
     * One run ID lets us distinguish mappings observed in this complete
     * Salesforce scan from stale mappings left by an earlier scan.
     */
    const syncStartedAt = new Date();

    let path =
        '/services/data/v65.0/query?q=' +
        encodeURIComponent(
            `
            SELECT
                Id,
                AccountId,
                Phone,
                MobilePhone,
                OtherPhone,
                HomePhone
            FROM Contact
            WHERE
                Phone != null
                OR MobilePhone != null
                OR OtherPhone != null
                OR HomePhone != null
            `.replace(/\s+/g, ' ').trim()
        );

    while (path) {
        const response =
            await fetchSalesforce(
                installationId,
                path
            );

        if (!response.ok) {
            throw new Error(
                `Salesforce Contact query failed with status ${response.status}`
            );
        }

        const data =
            await response.json() as
                SalesforceContactQueryResponse;

        const records =
            Array.isArray(data?.records)
                ? data.records
                : [];

        for (const contact of records) {
            contactsProcessed++;

            const contactId =
                typeof contact.Id === 'string'
                    ? contact.Id.trim()
                    : '';

            if (!contactId) {
                continue;
            }

            const accountId =
                typeof contact.AccountId === 'string' &&
                contact.AccountId.trim()
                    ? contact.AccountId.trim()
                    : null;

            const rawPhones = [
                contact.Phone,
                contact.MobilePhone,
                contact.OtherPhone,
                contact.HomePhone
            ].filter(
                (phone): phone is string =>
                    typeof phone === 'string' &&
                    phone.trim().length > 0
            );

            const normalizedPhones = [
                ...new Set(
                    rawPhones.flatMap(
                        phone => getPhoneVariants(phone)
                    )
                )
            ];

            if (normalizedPhones.length === 0) {
                continue;
            }

            contactsWithPhones++;

            for (
                const normalizedPhone of
                normalizedPhones
            ) {
                const result =
                    await db.query(
                        `
                        INSERT INTO
                            salesforce_contact_phone_mappings (
                                installation_id,
                                normalized_phone,
                                salesforce_contact_id,
                                salesforce_account_id,
                                source,
                                verified_at,
                                last_seen_at
                            )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            'SALESFORCE_CONTACT_DIRECTORY_SYNC',
                            $5,
                            $5
                        )
                        ON CONFLICT (
                            installation_id,
                            normalized_phone,
                            salesforce_contact_id
                        )
                        DO UPDATE SET
                            salesforce_account_id =
                                EXCLUDED.salesforce_account_id,
                            source =
                                EXCLUDED.source,
                            verified_at =
                                EXCLUDED.verified_at,
                            last_seen_at =
                                EXCLUDED.last_seen_at,
                            updated_at =
                                NOW()
                        RETURNING id
                        `,
                        [
                            installationId,
                            normalizedPhone,
                            contactId,
                            accountId,
                            syncStartedAt
                        ]
                    );

                if (result.rowCount === 1) {
                    mappingsWritten++;
                }
            }
        }

        path =
            data.done
                ? ''
                : data.nextRecordsUrl ?? '';
    }

    /*
     * Stale cleanup occurs only after the entire Salesforce Contact query
     * completed successfully. A partial/failed API run therefore cannot
     * erase valid mappings.
     *
     * Only directory-owned rows are deleted. Discovery-created mappings
     * remain independent until a future lifecycle policy explicitly
     * supersedes them.
     */
    const staleResult =
        await db.query(
            `
            DELETE FROM salesforce_contact_phone_mappings
            WHERE installation_id = $1
              AND source =
                  'SALESFORCE_CONTACT_DIRECTORY_SYNC'
              AND verified_at < $2
            `,
            [
                installationId,
                syncStartedAt
            ]
        );

    const staleMappingsRemoved =
        staleResult.rowCount ?? 0;

    console.log(
        '[COMMUNIK8 SALESFORCE CONTACT DIRECTORY SYNC SUCCESS]',
        {
            installationId,
            contactsProcessed,
            contactsWithPhones,
            mappingsWritten,
            staleMappingsRemoved
        }
    );

    return {
        contactsProcessed,
        contactsWithPhones,
        mappingsWritten,
        staleMappingsRemoved
    };
}
