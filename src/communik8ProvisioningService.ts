import { db } from './db.js';

import {
    syncCommunik8UsersFromZoom
} from './communic8UserSyncService.js';

import {
    syncCommunik8UsersFromSalesforce
} from './communic8SalesforceUserSyncService.js';

import {
    syncSmsSessionsForUser
} from './zoomSmsSyncService.js';

type MappedCommunik8User = {
    zoom_user_id: string;
};

export async function provisionCommunik8Installation(
    installationId: string
): Promise<{
    zoomUsersProcessed: number;
    salesforceUsersProcessed: number;
    matchedSalesforceUsers: number;
    smsUsersProcessed: number;
    smsSessionsProcessed: number;
}> {
    /*
     * Step 1:
     * Refresh the tenant's Zoom Phone user directory.
     *
     * This does NOT ingest SMS conversations.
     */
    const zoomResult =
        await syncCommunik8UsersFromZoom(
            installationId
        );

    /*
     * Step 2:
     * Match Salesforce users to the Zoom directory
     * using normalized email addresses.
     */
    const salesforceResult =
        await syncCommunik8UsersFromSalesforce(
            installationId
        );

    /*
     * Step 3:
     * Only users with both identities established,
     * active Zoom access, and unambiguous SMS capability
     * are eligible for SMS ingestion.
     */
    const mappedUsersResult =
        await db.query<MappedCommunik8User>(
            `
                SELECT zoom_user_id
                FROM communic8_users
                WHERE installation_id = $1
                AND salesforce_user_id IS NOT NULL
                AND zoom_user_id IS NOT NULL
                AND is_active = TRUE
                AND is_sms_capable = TRUE
                AND is_communik8_enabled = TRUE
                ORDER BY id
            `,
            [installationId]
        );

    let smsUsersProcessed = 0;
    let smsSessionsProcessed = 0;

    /*
     * Step 4:
     * Ingest each mapped user's session index through
     * Zoom's USER-SCOPED SMS endpoint.
     *
     * We intentionally do not call the account-wide
     * syncSmsSessions() function here.
     */
    for (const user of mappedUsersResult.rows) {
        const zoomUserId =
            user.zoom_user_id?.trim();

        if (!zoomUserId) {
            continue;
        }

        try {
            const smsResult =
                await syncSmsSessionsForUser(
                    installationId,
                    zoomUserId
                );

            smsUsersProcessed += 1;
            smsSessionsProcessed +=
                smsResult.sessionsProcessed;
        } catch (error) {
            /*
             * One user's Zoom SMS problem should not prevent
             * the remainder of the tenant from provisioning.
             *
             * Do not log the user's email, phone number,
             * message content, or Zoom user ID.
             */
            console.error(
                '[COMMUNIK8 USER SMS PROVISIONING FAILED]',
                {
                    installationId,
                    errorName:
                        error instanceof Error
                            ? error.name
                            : 'UnknownError'
                }
            );
        }
    }

    console.log(
        '[COMMUNIK8 INSTALLATION PROVISIONING SUCCESS]',
        {
            installationId,
            zoomUsersProcessed:
                zoomResult.usersProcessed,
            salesforceUsersProcessed:
                salesforceResult.salesforceUsersProcessed,
            matchedSalesforceUsers:
                salesforceResult.matchedUsers,
            smsUsersProcessed,
            smsSessionsProcessed
        }
    );

    return {
        zoomUsersProcessed:
            zoomResult.usersProcessed,

        salesforceUsersProcessed:
            salesforceResult.salesforceUsersProcessed,

        matchedSalesforceUsers:
            salesforceResult.matchedUsers,

        smsUsersProcessed,
        smsSessionsProcessed
    };
}