import {
    fetchSalesforce
} from './salesforceApiService.js';

import {
    COMMUNIK8_CAPABILITIES,
    grantCommunik8UserCapability,
    revokeCommunik8UserCapability
} from './communik8CapabilityService.js';

type SalesforceQueryResponse<T> = {
    totalSize?: number;
    done?: boolean;
    records?: T[];
};

type CustomPermissionRecord = {
    Id: string;
};

type SetupEntityAccessRecord = {
    ParentId: string;
};

type PermissionSetAssignmentRecord = {
    Id: string;
};

const VIEW_ALL_MESSAGES_CUSTOM_PERMISSION =
    'Communik8_View_All_Messages';

function soqlPath(soql: string): string {
    return (
        '/services/data/v65.0/query?q=' +
        encodeURIComponent(
            soql.replace(/\s+/g, ' ').trim()
        )
    );
}

async function querySalesforce<T>(
    installationId: string,
    soql: string
): Promise<T[]> {
    const response =
        await fetchSalesforce(
            installationId,
            soqlPath(soql)
        );

    if (!response.ok) {
        console.error(
            '[SALESFORCE CAPABILITY SYNC QUERY FAILED]',
            {
                installationId,
                status: response.status
            }
        );

        throw new Error(
            `Salesforce capability query failed with status ${response.status}`
        );
    }

    const data =
        await response.json() as SalesforceQueryResponse<T>;

    return Array.isArray(data.records)
        ? data.records
        : [];
}

/**
 * Determine whether one Salesforce user has the packaged
 * Communik8_View_All_Messages Custom Permission.
 *
 * We resolve:
 *
 *   CustomPermission
 *       -> SetupEntityAccess.ParentId (Permission Set)
 *       -> PermissionSetAssignment.AssigneeId (User)
 *
 * This avoids trusting a boolean supplied by the LWC or Apex caller.
 */
export async function salesforceUserHasViewAllMessagesPermission(
    installationId: string,
    salesforceUserId: string
): Promise<boolean> {
    const customPermissions =
        await querySalesforce<CustomPermissionRecord>(
            installationId,
            `
            SELECT Id
            FROM CustomPermission
            WHERE DeveloperName =
                '${VIEW_ALL_MESSAGES_CUSTOM_PERMISSION}'
            LIMIT 2
            `
        );

    if (customPermissions.length !== 1) {
        /*
         * Fail closed when the packaged permission cannot be
         * resolved uniquely in this Salesforce org.
         */
        return false;
    }

    const customPermissionId =
        customPermissions[0].Id;

    const setupAccess =
        await querySalesforce<SetupEntityAccessRecord>(
            installationId,
            `
            SELECT ParentId
            FROM SetupEntityAccess
            WHERE SetupEntityId =
                '${customPermissionId}'
            `
        );

    const permissionSetIds =
        Array.from(
            new Set(
                setupAccess
                    .map(record => record.ParentId)
                    .filter(Boolean)
            )
        );

    if (permissionSetIds.length === 0) {
        return false;
    }

    const quotedPermissionSetIds =
        permissionSetIds
            .map(id => `'${id}'`)
            .join(',');

    const assignments =
        await querySalesforce<PermissionSetAssignmentRecord>(
            installationId,
            `
            SELECT Id
            FROM PermissionSetAssignment
            WHERE AssigneeId =
                '${salesforceUserId}'
              AND PermissionSetId IN (
                ${quotedPermissionSetIds}
              )
            LIMIT 1
            `
        );

    return assignments.length === 1;
}

/**
 * Synchronize Salesforce admin authorization into the durable
 * Communik8 backend capability row.
 *
 * Salesforce controls WHO is allowed to use the feature.
 * The Communik8 backend still enforces the capability independently.
 *
 * A future installation/subscription entitlement can be added as
 * another required gate without changing this user authorization model.
 */
export async function syncViewAllMessagesCapabilityFromSalesforce(
    installationId: string,
    salesforceUserId: string,
    communic8UserId: number
): Promise<boolean> {
    const hasPermission =
        await salesforceUserHasViewAllMessagesPermission(
            installationId,
            salesforceUserId
        );

    if (hasPermission) {
        await grantCommunik8UserCapability(
            installationId,
            communic8UserId,
            COMMUNIK8_CAPABILITIES.VIEW_ALL_MESSAGES,
            'SALESFORCE_CUSTOM_PERMISSION',
            null
        );
    } else {
        await revokeCommunik8UserCapability(
            installationId,
            communic8UserId,
            COMMUNIK8_CAPABILITIES.VIEW_ALL_MESSAGES
        );
    }

    console.log(
        '[COMMUNIK8 SALESFORCE CAPABILITY SYNC]',
        {
            installationId,
            communic8UserId,
            capability:
                COMMUNIK8_CAPABILITIES.VIEW_ALL_MESSAGES,
            enabled:
                hasPermission
        }
    );

    return hasPermission;
}
