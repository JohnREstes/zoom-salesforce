import { db } from './db.js';

import {
    syncCommunik8UsersFromZoom
} from './communic8UserSyncService.js';

import {
    syncCommunik8UsersFromSalesforce
} from './communic8SalesforceUserSyncService.js';

export type Communik8CurrentUser = {
    id: number;
    installationId: string;
    salesforceUserId: string;
    zoomUserId: string;
    isActive: boolean;
    isSmsCapable: boolean;
    isCommunik8Enabled: boolean;
};

async function findCurrentUser(
    installationId: string,
    salesforceUserId: string
): Promise<Communik8CurrentUser | null> {
    const result = await db.query<{
        id: number;
        installation_id: string;
        salesforce_user_id: string;
        zoom_user_id: string;
        is_active: boolean;
        is_sms_capable: boolean;
        is_communik8_enabled: boolean;
    }>(
        `
        SELECT
            id,
            installation_id,
            salesforce_user_id,
            zoom_user_id,
            is_active,
            is_sms_capable,
            is_communik8_enabled
        FROM communic8_users
        WHERE installation_id = $1
          AND salesforce_user_id = $2
          AND zoom_user_id IS NOT NULL
        LIMIT 2
        `,
        [
            installationId,
            salesforceUserId
        ]
    );

    /*
     * Identity must fail closed.
     *
     * We should never proceed if somehow more than one
     * Communik8 identity is associated with the same
     * Salesforce user inside an installation.
     */
    if (result.rowCount !== 1) {
        return null;
    }

    const row = result.rows[0];

    return {
        id: Number(row.id),
        installationId:
            row.installation_id,
        salesforceUserId:
            row.salesforce_user_id,
        zoomUserId:
            row.zoom_user_id,
        isActive:
            row.is_active,
        isSmsCapable:
            row.is_sms_capable,
        isCommunik8Enabled:
            row.is_communik8_enabled
    };
}

/**
 * Resolve the Communik8 identity for the current Salesforce user.
 *
 * Fast path:
 *   Return the existing durable Salesforce ↔ Zoom mapping.
 *
 * Self-healing path:
 *   If no mapping exists, refresh the Zoom directory and then
 *   rerun Salesforce identity matching before checking again.
 *
 * This replaces the manual sync commands that were needed
 * while onboarding test users.
 */
export async function resolveCommunik8CurrentUser(
    installationId: string,
    salesforceUserId: string
): Promise<Communik8CurrentUser | null> {
    const existing =
        await findCurrentUser(
            installationId,
            salesforceUserId
        );

    if (existing) {
        return existing;
    }

    console.log(
        '[COMMUNIK8 CURRENT USER SELF-HEAL START]',
        {
            installationId
        }
    );

    /*
     * Refresh Zoom first because Salesforce matching expects
     * the Zoom-side communic8_users rows to already exist.
     */
    await syncCommunik8UsersFromZoom(
        installationId
    );

    /*
     * Then match Salesforce users to Zoom users by normalized
     * email using the existing fail-closed matching service.
     */
    await syncCommunik8UsersFromSalesforce(
        installationId
    );

    const repaired =
        await findCurrentUser(
            installationId,
            salesforceUserId
        );

    console.log(
        '[COMMUNIK8 CURRENT USER SELF-HEAL COMPLETE]',
        {
            installationId,
            mapped: Boolean(repaired)
        }
    );

    return repaired;
}