import { db } from './db.js';

import {
    encrypt,
    decrypt
} from './crypto.js';

type SalesforceConnectionRow = {
    id: string;
    instance_url: string | null;
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
};

type SalesforceTokenResponse = {
    access_token?: string;
    refresh_token?: string;
    instance_url?: string;
    token_type?: string;
    scope?: string;
    issued_at?: string;
    error?: string;
    error_description?: string;
};

export type SalesforceAccess = {
    accessToken: string;
    instanceUrl: string;
};

/**
 * Return the currently stored Salesforce access token.
 *
 * This does not try to determine whether the token has expired.
 * Salesforce API callers should use the token normally and refresh
 * only when Salesforce reports that the session is invalid.
 */
export async function getSalesforceAccessToken(
    installationId: string
): Promise<SalesforceAccess> {
    const result =
        await db.query<SalesforceConnectionRow>(
            `
            SELECT
                id,
                instance_url,
                access_token_encrypted,
                refresh_token_encrypted
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

    return {
        accessToken:
            decrypt(
                connection.access_token_encrypted
            ),

        instanceUrl:
            connection.instance_url
    };
}

/**
 * Refresh the Salesforce access token.
 *
 * The row is locked during refresh so two concurrent requests
 * cannot rotate the same refresh token at the same time.
 */
export async function refreshSalesforceAccessToken(
    installationId: string
): Promise<SalesforceAccess> {
    const client =
        await db.connect();

    try {
        await client.query('BEGIN');

        const result =
            await client.query<SalesforceConnectionRow>(
                `
                SELECT
                    id,
                    instance_url,
                    access_token_encrypted,
                    refresh_token_encrypted
                FROM salesforce_connections
                WHERE installation_id = $1
                LIMIT 1
                FOR UPDATE
                `,
                [installationId]
            );

        if (result.rowCount !== 1) {
            throw new Error(
                'Salesforce connection not found'
            );
        }

        const connection =
            result.rows[0];

        if (
            !connection.instance_url ||
            !connection.refresh_token_encrypted
        ) {
            throw new Error(
                'Salesforce refresh token is unavailable'
            );
        }

        const clientId =
            process.env.SALESFORCE_CLIENT_ID;

        const clientSecret =
            process.env.SALESFORCE_CLIENT_SECRET;

        if (
            !clientId ||
            !clientSecret
        ) {
            throw new Error(
                'Salesforce OAuth is not configured'
            );
        }

        const refreshToken =
            decrypt(
                connection.refresh_token_encrypted
            );

        const tokenUrl =
            new URL(
                `${connection.instance_url}/services/oauth2/token`
            );

        const body =
            new URLSearchParams();

        body.set(
            'grant_type',
            'refresh_token'
        );

        body.set(
            'client_id',
            clientId
        );

        body.set(
            'client_secret',
            clientSecret
        );

        body.set(
            'refresh_token',
            refreshToken
        );

        const response =
            await fetch(
                tokenUrl.toString(),
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/x-www-form-urlencoded'
                    },
                    body: body.toString()
                }
            );

        const tokenData =
            (await response.json()) as SalesforceTokenResponse;

        if (
            !response.ok ||
            !tokenData.access_token
        ) {
            console.error(
                '[SALESFORCE TOKEN REFRESH FAILED]',
                {
                    installationId,
                    status: response.status,
                    error: tokenData.error,
                    description:
                        tokenData.error_description
                }
            );

            throw new Error(
                `Salesforce token refresh failed with status ${response.status}`
            );
        }

        const newInstanceUrl =
            tokenData.instance_url ||
            connection.instance_url;

        const accessTokenEncrypted =
            encrypt(
                tokenData.access_token
            );

        /*
         * Refresh token rotation is enabled on the
         * Salesforce External Client App.
         *
         * If Salesforce returns a replacement refresh token,
         * persist it immediately. If it does not return one,
         * preserve the currently stored token.
         */
        const newRefreshTokenEncrypted =
            tokenData.refresh_token
                ? encrypt(
                    tokenData.refresh_token
                )
                : null;

        await client.query(
            `
            UPDATE salesforce_connections
            SET
                instance_url = $1,
                access_token_encrypted = $2,
                refresh_token_encrypted =
                    COALESCE(
                        $3,
                        refresh_token_encrypted
                    ),
                scope =
                    COALESCE(
                        $4,
                        scope
                    ),
                updated_at = NOW()
            WHERE installation_id = $5
            `,
            [
                newInstanceUrl,
                accessTokenEncrypted,
                newRefreshTokenEncrypted,
                tokenData.scope ?? null,
                installationId
            ]
        );

        await client.query('COMMIT');

        console.log(
            '[SALESFORCE TOKEN REFRESH SUCCESS]',
            {
                installationId,
                rotatedRefreshToken:
                    Boolean(
                        tokenData.refresh_token
                    )
            }
        );

        return {
            accessToken:
                tokenData.access_token,

            instanceUrl:
                newInstanceUrl
        };
    } catch (error) {
        try {
            await client.query(
                'ROLLBACK'
            );
        } catch {
            // Preserve the original error.
        }

        throw error;
    } finally {
        client.release();
    }
}