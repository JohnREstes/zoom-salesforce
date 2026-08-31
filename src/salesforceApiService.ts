import { db } from './db.js';
import { decrypt } from './crypto.js';

type SalesforceConnection = {
    instance_url: string;
    access_token_encrypted: string;
};

export async function testSalesforceConnection(
    installationId: string
): Promise<{
    ok: boolean;
    status: number;
    instanceUrl: string;
}> {
    const result = await db.query<SalesforceConnection>(
        `
        SELECT
            instance_url,
            access_token_encrypted
        FROM salesforce_connections
        WHERE installation_id = $1
        LIMIT 1
        `,
        [installationId]
    );

    if (result.rowCount !== 1) {
        throw new Error(
            'Salesforce connection not found'
        );
    }

    const connection = result.rows[0];

    if (
        !connection.instance_url ||
        !connection.access_token_encrypted
    ) {
        throw new Error(
            'Salesforce connection is incomplete'
        );
    }

    const accessToken =
        decrypt(
            connection.access_token_encrypted
        );

    const response =
        await fetch(
            `${connection.instance_url}/services/data/v65.0/limits`,
            {
                headers: {
                    Authorization:
                        `Bearer ${accessToken}`,
                    Accept: 'application/json'
                }
            }
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
        status: response.status,
        instanceUrl:
            connection.instance_url
    };
}