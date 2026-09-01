import {
    getSalesforceAccessToken,
    refreshSalesforceAccessToken
} from './salesforceTokenService.js';

type SalesforcePublishResponse = {
    id?: string;
    success?: boolean;
    errors?: unknown[];
};

async function publishWithAccess(
    installationId: string,
    access: {
        accessToken: string;
        instanceUrl: string;
    },
    payload: Record<string, string | null>
): Promise<Response> {
    return fetch(
        `${access.instanceUrl}` +
        `/services/data/v67.0/sobjects/` +
        `Communik8_Message_Event__e`,
        {
            method: 'POST',
            headers: {
                Authorization:
                    `Bearer ${access.accessToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        }
    );
}

export async function publishCommunik8MessageEvent(
    installationId: string,
    options: {
        contactId?: string | null;
        accountId?: string | null;
        smsSessionId: number | string;
        eventType: 'SMS_RECEIVED' | 'SMS_SENT';
    }
): Promise<void> {
    const payload = {
        Contact_Id__c:
            options.contactId ?? null,

        Account_Id__c:
            options.accountId ?? null,

        SMS_Session_Id__c:
            String(options.smsSessionId),

        Event_Type__c:
            options.eventType
    };

    let access =
        await getSalesforceAccessToken(
            installationId
        );

    let response =
        await publishWithAccess(
            installationId,
            access,
            payload
        );

    /*
     * Salesforce access tokens are intentionally
     * refreshed only when Salesforce reports that
     * the current session is invalid.
     */
    if (response.status === 401) {
        access =
            await refreshSalesforceAccessToken(
                installationId
            );

        response =
            await publishWithAccess(
                installationId,
                access,
                payload
            );
    }

    const responseBody =
        await response
            .json()
            .catch(() => null) as
            SalesforcePublishResponse | null;

    if (!response.ok) {
        console.error(
            '[SALESFORCE PLATFORM EVENT FAILED]',
            {
                installationId,
                eventType: options.eventType,
                status: response.status
            }
        );

        throw new Error(
            `Salesforce Platform Event publish failed with status ${response.status}`
        );
    }

    console.log(
        '[SALESFORCE PLATFORM EVENT PUBLISHED]',
        {
            installationId,
            eventType: options.eventType,
            hasContactId:
                Boolean(options.contactId),
            hasAccountId:
                Boolean(options.accountId),
            status:
                response.status,
            success:
                responseBody?.success === true,
            hasEventId:
                Boolean(responseBody?.id),
            errorCount:
                Array.isArray(responseBody?.errors)
                    ? responseBody.errors.length
                    : 0
        }
    );
}