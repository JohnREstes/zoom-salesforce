import { db } from './db.js';

import {
    syncCommunik8UsersFromSalesforce
} from './communic8SalesforceUserSyncService.js';

import {
    syncSalesforceContactPhoneDirectory
} from './communic8SalesforceContactDirectorySyncService.js';

const DEFAULT_INTERVAL_MS =
    6 * 60 * 60 * 1000;

const DEFAULT_STARTUP_DELAY_MS =
    15 * 1000;

function parsePositiveInteger(
    value: string | undefined,
    defaultValue: number
): number {
    if (!value) {
        return defaultValue;
    }

    const parsed = Number(value);

    if (
        !Number.isInteger(parsed) ||
        parsed < 1
    ) {
        return defaultValue;
    }

    return parsed;
}

const DIRECTORY_SYNC_INTERVAL_MS =
    parsePositiveInteger(
        process.env
            .COMMUNIK8_SALESFORCE_DIRECTORY_SYNC_INTERVAL_MS,
        DEFAULT_INTERVAL_MS
    );

const DIRECTORY_SYNC_STARTUP_DELAY_MS =
    parsePositiveInteger(
        process.env
            .COMMUNIK8_SALESFORCE_DIRECTORY_SYNC_STARTUP_DELAY_MS,
        DEFAULT_STARTUP_DELAY_MS
    );

let directorySyncRunning = false;

let directorySyncTimer:
    ReturnType<typeof setInterval> | null =
        null;

type SalesforceConnectedInstallationRow = {
    installation_id: string;
};

async function getSalesforceConnectedInstallations():
Promise<string[]> {
    const result =
        await db.query<SalesforceConnectedInstallationRow>(
            `
            SELECT DISTINCT
                sc.installation_id
            FROM salesforce_connections sc
            INNER JOIN installations i
                ON i.id = sc.installation_id
            WHERE sc.instance_url IS NOT NULL
              AND sc.access_token_encrypted IS NOT NULL
            ORDER BY sc.installation_id
            `
        );

    return result.rows.map(
        row => row.installation_id
    );
}

export async function runSalesforceDirectorySync():
Promise<void> {
    if (directorySyncRunning) {
        console.log(
            '[SALESFORCE DIRECTORY SYNC SKIPPED] Previous run still active'
        );

        return;
    }

    directorySyncRunning = true;

    try {
        const installationIds =
            await getSalesforceConnectedInstallations();

        if (installationIds.length === 0) {
            console.log(
                '[SALESFORCE DIRECTORY SYNC COMPLETE]',
                {
                    installationCount: 0,
                    successfulInstallations: 0,
                    failedInstallations: 0
                }
            );

            return;
        }

        console.log(
            '[SALESFORCE DIRECTORY SYNC START]',
            {
                installationCount:
                    installationIds.length
            }
        );

        let successfulInstallations = 0;
        let failedInstallations = 0;

        /*
         * Run installations sequentially.
         *
         * This avoids creating a burst of Salesforce API traffic
         * when Communik8 has multiple customer installations.
         */
        for (const installationId of installationIds) {
            try {
                const userResult =
                    await syncCommunik8UsersFromSalesforce(
                        installationId
                    );

                const contactResult =
                    await syncSalesforceContactPhoneDirectory(
                        installationId
                    );

                successfulInstallations++;

                console.log(
                    '[SALESFORCE DIRECTORY INSTALLATION SYNC COMPLETE]',
                    {
                        installationId,

                        salesforceUsersProcessed:
                            userResult.salesforceUsersProcessed,
                        matchedUsers:
                            userResult.matchedUsers,
                        unmatchedSalesforceUsers:
                            userResult.unmatchedSalesforceUsers,

                        contactsProcessed:
                            contactResult.contactsProcessed,
                        contactsWithPhones:
                            contactResult.contactsWithPhones,
                        contactMappingsWritten:
                            contactResult.mappingsWritten,
                        staleContactMappingsRemoved:
                            contactResult.staleMappingsRemoved
                    }
                );
            } catch (error) {
                failedInstallations++;

                console.warn(
                    '[SALESFORCE DIRECTORY INSTALLATION SYNC FAILED]',
                    {
                        installationId,
                        error:
                            error instanceof Error
                                ? error.message
                                : 'Unknown error'
                    }
                );
            }
        }

        console.log(
            '[SALESFORCE DIRECTORY SYNC COMPLETE]',
            {
                installationCount:
                    installationIds.length,
                successfulInstallations,
                failedInstallations
            }
        );
    } catch (error) {
        console.error(
            '[SALESFORCE DIRECTORY SYNC WORKER FAILED]',
            error
        );
    } finally {
        directorySyncRunning = false;
    }
}

export function startSalesforceDirectorySyncWorker():
void {
    if (directorySyncTimer) {
        return;
    }

    console.log(
        '[SALESFORCE DIRECTORY SYNC WORKER STARTED]',
        {
            intervalMinutes:
                DIRECTORY_SYNC_INTERVAL_MS /
                60_000,
            startupDelaySeconds:
                DIRECTORY_SYNC_STARTUP_DELAY_MS /
                1000
        }
    );

    /*
     * Refresh shortly after application startup so a deploy or
     * process restart does not wait for the next six-hour cycle.
     */
    setTimeout(() => {
        void runSalesforceDirectorySync();
    }, DIRECTORY_SYNC_STARTUP_DELAY_MS);

    directorySyncTimer =
        setInterval(() => {
            void runSalesforceDirectorySync();
        }, DIRECTORY_SYNC_INTERVAL_MS);
}
