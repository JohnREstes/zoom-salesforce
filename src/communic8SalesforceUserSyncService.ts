import { db } from './db.js';
import { fetchSalesforce } from './salesforceApiService.js';

type SalesforceUserRecord = {
    Id: string;
    Email?: string | null;
    IsActive?: boolean;
};

type SalesforceQueryResponse = {
    done: boolean;
    nextRecordsUrl?: string;
    records?: SalesforceUserRecord[];
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
            SELECT Id, Email, IsActive
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

            const salesforceEmail =
                typeof salesforceUser.Email === 'string'
                    ? salesforceUser.Email
                        .trim()
                        .toLowerCase()
                    : '';

            if (!salesforceUserId || !salesforceEmail) {
                continue;
            }

            const candidateResult =
                await db.query<{
                    id: number;
                }>(
                    `
                        SELECT id
                        FROM communic8_users
                        WHERE installation_id = $1
                        AND LOWER(zoom_email) = $2
                        ORDER BY id
                        LIMIT 2
                    `,
                    [
                        installationId,
                        salesforceEmail
                    ]
                );

            /*
            * Identity matching must fail closed.
            *
            * Zero Zoom matches:
            *   Salesforce user remains unmatched.
            *
            * Multiple Zoom matches:
            *   Ambiguous identity. Do not update any row.
            *
            * Exactly one Zoom match:
            *   Safe to establish the durable Salesforce ↔ Zoom
            *   identity relationship.
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
                            matched_at = NOW(),
                            updated_at = NOW()
                        WHERE id = $3
                        AND installation_id = $4
                        RETURNING id
                    `,
                    [
                        salesforceUserId,
                        salesforceEmail,
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