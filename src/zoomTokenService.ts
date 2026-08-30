import 'dotenv/config';

import { db } from './db.js';
import { decrypt, encrypt } from './crypto.js';

type ZoomTokenRow = {
    id: number;
    installation_id: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string;
    access_token_expires_at: Date;
};

type ZoomRefreshResponse = {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
    token_type?: string;
};

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function getValidZoomAccessToken(
    installationId: string
): Promise<string> {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const tokenResult = await client.query<ZoomTokenRow>(
            `
            SELECT
                id,
                installation_id,
                access_token_encrypted,
                refresh_token_encrypted,
                access_token_expires_at
            FROM zoom_oauth_tokens
            WHERE installation_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
            `,
            [installationId]
        );

        if (tokenResult.rowCount !== 1) {
            throw new Error(
                'Zoom authorization not found for installation'
            );
        }

        const token = tokenResult.rows[0];

        const expiresAt =
            new Date(token.access_token_expires_at).getTime();

        /*
         * If the access token has more than five minutes
         * remaining, simply return it.
         */
        if (
            Number.isFinite(expiresAt) &&
            expiresAt - Date.now() > REFRESH_BUFFER_MS
        ) {
            const accessToken = decrypt(
                token.access_token_encrypted
            );

            await client.query('COMMIT');

            return accessToken;
        }

        /*
         * Access token is expired or approaching expiration.
         * Refresh it while this token row is locked.
         */
        const refreshToken = decrypt(
            token.refresh_token_encrypted
        );

        const clientId = process.env.ZOOM_CLIENT_ID;
        const clientSecret = process.env.ZOOM_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            throw new Error(
                'Zoom OAuth client configuration is missing'
            );
        }

        const basicAuth = Buffer
            .from(`${clientId}:${clientSecret}`)
            .toString('base64');

        const tokenUrl = new URL(
            'https://zoom.us/oauth/token'
        );

        tokenUrl.searchParams.set(
            'grant_type',
            'refresh_token'
        );

        tokenUrl.searchParams.set(
            'refresh_token',
            refreshToken
        );

        const response = await fetch(
            tokenUrl.toString(),
            {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${basicAuth}`,
                    'Content-Type':
                        'application/x-www-form-urlencoded'
                }
            }
        );

        const responseBody =
            await response.json() as ZoomRefreshResponse;

        if (!response.ok) {
            console.error('[ZOOM TOKEN REFRESH FAILED]', {
                installationId,
                status: response.status
            });

            throw new Error(
                `Zoom token refresh failed with status ${response.status}`
            );
        }

        if (
            !responseBody.access_token ||
            !responseBody.refresh_token ||
            !responseBody.expires_in
        ) {
            throw new Error(
                'Zoom token refresh returned incomplete credentials'
            );
        }

        const newExpiresAt = new Date(
            Date.now() +
            Number(responseBody.expires_in) * 1000
        );

        /*
         * IMPORTANT:
         * Persist BOTH tokens. The newly returned refresh
         * token replaces the old refresh token.
         */
        await client.query(
            `
            UPDATE zoom_oauth_tokens
            SET
                access_token_encrypted = $1,
                refresh_token_encrypted = $2,
                access_token_expires_at = $3,
                scope = COALESCE($4, scope),
                token_type = COALESCE($5, token_type),
                updated_at = NOW()
            WHERE id = $6
            `,
            [
                encrypt(responseBody.access_token),
                encrypt(responseBody.refresh_token),
                newExpiresAt,
                responseBody.scope ?? null,
                responseBody.token_type ?? null,
                token.id
            ]
        );

        await client.query('COMMIT');

        console.log('[ZOOM TOKEN REFRESH SUCCESS]', {
            installationId,
            expiresIn: responseBody.expires_in
        });

        return responseBody.access_token;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original error.
        }

        throw error;
    } finally {
        client.release();
    }
}