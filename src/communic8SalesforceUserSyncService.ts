import { db } from './db.js';
import { fetchSalesforce } from './salesforceApiService.js';

type SalesforceUserRecord = {
    Id: string;
    Name?: string | null;
    Email?: string | null;
    IsActive?: boolean;
};

type SalesforceQueryResponse = {
    done: boolean;
    nextRecordsUrl?: string;
    records?: SalesforceUserRecord[];
};

type Communik8UserCandidate = {
    id: number;
};

export async function syncCommunik8UsersFromSalesforce(
    installationId: string
): Promise<{
    salesforceUsersProcessed: number;
    matchedUsers: number;
    unmatchedSalesforceUsers: number;
}> {
    let salesforceUsersProcessed = 0;
    let matchedUsers = 0;
    let unmatchedSalesforceUsers = 0;

    let path =
        '/services/data/v65.0/query?q=' +
        encodeURIComponent(
            `
            SELECT Id, Name, Email, IsActive
            FROM User
            WHERE Email != null
            `.replace(/\s+/g, ' ').trim()
        );

    while (path) {
        const response =
            await fetchSalesforce(
                installationId,
                path
            );

        if (!response.ok) {
            console.error(
                '[COMMUNIK8 SALESFORCE USER SYNC API ERROR]',
                {
                    installationId,
                    status: response.status
                }
            );

            throw new Error(
                `Salesforce User query failed with status ${response.status}`
            );
        }

        const data =
            await response.json() as SalesforceQueryResponse;

        const records =
            Array.isArray(data?.records)
                ? data.records
                : [];

        for (const salesforceUser of records) {
            salesforceUsersProcessed++;

            const salesforceUserId =
                typeof salesforceUser.Id === 'string'
                    ? salesforceUser.Id.trim()
                    : '';

            const salesforceName =
                typeof salesforceUser.Name === 'string'
                    ? salesforceUser.Name.trim()
                    : '';

            const salesforceEmail =
                typeof salesforceUser.Email === 'string'
                    ? salesforceUser.Email
                        .trim()
                        .toLowerCase()
                    : '';

            const salesforceIsActive =
                salesforceUser.IsActive === true;

            if (!salesforceUserId || !salesforceEmail) {
                continue;
            }

            /*
             * Prefer an existing durable Salesforce mapping first.
             *
             * This allows a Salesforce user's email address to change
             * without breaking the Communik8 identity relationship.
             */
            let candidateResult =
                await db.query<Communik8UserCandidate>(
                    `
                        SELECT id
                        FROM communic8_users
                        WHERE installation_id = $1
                          AND salesforce_user_id = $2
                        ORDER BY id
                        LIMIT 2
                    `,
                    [
                        installationId,
                        salesforceUserId
                    ]
                );

            if (
                candidateResult.rowCount !== null &&
                candidateResult.rowCount > 1
            ) {
                unmatchedSalesforceUsers++;

                console.warn(
                    '[COMMUNIK8 SALESFORCE USER MAPPING AMBIGUOUS]',
                    {
                        installationId,
                        candidateCount:
                            candidateResult.rowCount
                    }
                );

                continue;
            }

            /*
             * If no durable Salesforce mapping exists yet, fall back
             * to the original deterministic email match against Zoom.
             *
             * Never take over a Communik8 row already mapped to a
             * different Salesforce user.
             */
            if (candidateResult.rowCount === 0) {
                candidateResult =
                    await db.query<Communik8UserCandidate>(
                        `
                            SELECT id
                            FROM communic8_users
                            WHERE installation_id = $1
                              AND LOWER(zoom_email) = $2
                              AND (
                                  salesforce_user_id IS NULL
                                  OR salesforce_user_id = $3
                              )
                            ORDER BY id
                            LIMIT 2
                        `,
                        [
                            installationId,
                            salesforceEmail,
                            salesforceUserId
                        ]
                    );
            }

            /*
             * Identity matching must fail closed.
             *
             * Zero candidates:
             *   Salesforce user remains unmatched.
             *
             * Multiple candidates:
             *   Ambiguous identity. Do not update any row.
             *
             * Exactly one candidate:
             *   Safe to refresh the durable Salesforce identity.
             */
            if (candidateResult.rowCount !== 1) {
                unmatchedSalesforceUsers++;

                if (
                    candidateResult.rowCount !== null &&
                    candidateResult.rowCount > 1
                ) {
                    console.warn(
                        '[COMMUNIK8 USER IDENTITY MATCH AMBIGUOUS]',
                        {
                            installationId,
                            candidateCount:
                                candidateResult.rowCount
                        }
                    );
                }

                continue;
            }

            const communic8UserId =
                candidateResult.rows[0].id;

            const matchResult =
                await db.query(
                    `
                        UPDATE communic8_users
                        SET
                            salesforce_user_id = $1,
                            salesforce_email = $2,
                            salesforce_name = NULLIF($3, ''),
                            salesforce_is_active = $4,
                            salesforce_synced_at = NOW(),
                            matched_at = COALESCE(
                                matched_at,
                                NOW()
                            ),
                            updated_at = NOW()
                        WHERE id = $5
                          AND installation_id = $6
                        RETURNING id
                    `,
                    [
                        salesforceUserId,
                        salesforceEmail,
                        salesforceName,
                        salesforceIsActive,
                        communic8UserId,
                        installationId
                    ]
                );

            if (matchResult.rowCount === 1) {
                matchedUsers++;
            } else {
                unmatchedSalesforceUsers++;
            }
        }

        path =
            data.done
                ? ''
                : data.nextRecordsUrl ?? '';
    }

    console.log(
        '[COMMUNIK8 SALESFORCE USER SYNC SUCCESS]',
        {
            installationId,
            salesforceUsersProcessed,
            matchedUsers,
            unmatchedSalesforceUsers
        }
    );

    return {
        salesforceUsersProcessed,
        matchedUsers,
        unmatchedSalesforceUsers
    };
}
