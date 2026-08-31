import {
    getSalesforceAccessToken,
    refreshSalesforceAccessToken
} from './salesforceTokenService.js';

export async function fetchSalesforce(
    installationId: string,
    path: string,
    init?: RequestInit
): Promise<Response> {
    let access =
        await getSalesforceAccessToken(
            installationId
        );

    let response =
        await fetch(
            `${access.instanceUrl}${path}`,
            {
                ...init,
                headers: {
                    ...(init?.headers ?? {}),
                    Authorization:
                        `Bearer ${access.accessToken}`,
                    Accept: 'application/json'
                }
            }
        );

    if (response.status !== 401) {
        return response;
    }

    access =
        await refreshSalesforceAccessToken(
            installationId
        );

    response =
        await fetch(
            `${access.instanceUrl}${path}`,
            {
                ...init,
                headers: {
                    ...(init?.headers ?? {}),
                    Authorization:
                        `Bearer ${access.accessToken}`,
                    Accept: 'application/json'
                }
            }
        );

    return response;
}

export async function testSalesforceConnection(
    installationId: string
): Promise<{
    ok: boolean;
    status: number;
}> {
    const response =
        await fetchSalesforce(
            installationId,
            '/services/data/v65.0/limits'
        );

    if (!response.ok) {
        console.error(
            '[SALESFORCE API TEST FAILED]',
            {
                installationId,
                status: response.status
            }
        );

        throw new Error(
            `Salesforce API test failed with status ${response.status}`
        );
    }

    console.log(
        '[SALESFORCE API TEST SUCCESS]',
        {
            installationId,
            status: response.status
        }
    );

    return {
        ok: true,
        status: response.status
    };
}