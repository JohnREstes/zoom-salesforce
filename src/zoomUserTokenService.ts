import { db } from './db.js';
import { encrypt, decrypt } from './crypto.js';

const ZOOM_OAUTH_TOKEN_URL = 'https://zoom.us/oauth/token';

type ZoomUserTokenRow = {
    id: number;
    installation_id: string;
    communic8_user_id: number;
    zoom_user_id: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string;
    access_token_expires_at: Date;
    scope: string | null;
    token_type: string | null;
};

type ZoomTokenResponse = {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    token_type?: string;
};

function getZoomOAuthCredentials(): {
    clientId: string;
    clientSecret: string;
} {
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error(
            'Zoom OAuth client credentials are not configured'
        );
    }

    return {
        clientId,
        clientSecret
    };
}

export async function saveZoomUserOAuthTokens(
    options: {
        installationId: string;
        communic8UserId: number;
        zoomUserId: string;
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        scope?: string | null;
        tokenType?: string | null;
    }
): Promise<void> {
    const expiresAt = new Date(
        Date.now() + options.expiresIn * 1000
    );

    await db.query(
        `
        INSERT INTO zoom_user_oauth_tokens (
            installation_id,
            communic8_user_id,
            zoom_user_id,
            access_token_encrypted,
            refresh_token_encrypted,
            access_token_expires_at,
            scope,
            token_type,
            authorized_at,
            updated_at
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NOW(),
            NOW()
        )
        ON CONFLICT (
            installation_id,
            communic8_user_id
        )
        DO UPDATE SET
            zoom_user_id =
                EXCLUDED.zoom_user_id,
            access_token_encrypted =
                EXCLUDED.access_token_encrypted,
            refresh_token_encrypted =
                EXCLUDED.refresh_token_encrypted,
            access_token_expires_at =
                EXCLUDED.access_token_expires_at,
            scope =
                EXCLUDED.scope,
            token_type =
                EXCLUDED.token_type,
            authorized_at =
                NOW(),
            updated_at =
                NOW()
        `,
        [
            options.installationId,
            options.communik8UserId,
            options.zoomUserId,
            encrypt(options.accessToken),
            encrypt(options.refreshToken),
            expiresAt,
            options.scope ?? null,
            options.tokenType ?? null
        ]
    );
}

export async function getZoomUserOAuthStatus(
    installationId: string,
    communic8UserId: number
): Promise<{
    connected: boolean;
    zoomUserId: string | null;
    expiresAt: Date | null;
}> {
    const result = await db.query(
        `
        SELECT
            zoom_user_id,
            access_token_expires_at
        FROM zoom_user_oauth_tokens
        WHERE installation_id = $1
          AND communic8_user_id = $2
        LIMIT 1
        `,
        [
            installationId,
            communic8UserId
        ]
    );

    if (result.rowCount !== 1) {
        return {
            connected: false,
            zoomUserId: null,
            expiresAt: null
        };
    }

    return {
        connected: true,
        zoomUserId:
            result.rows[0].zoom_user_id,
        expiresAt:
            result.rows[0].access_token_expires_at
    };
}

export async function deleteZoomUserOAuthTokens(
    installationId: string,
    communic8UserId: number
): Promise<void> {
    await db.query(
        `
        DELETE FROM zoom_user_oauth_tokens
        WHERE installation_id = $1
          AND communic8_user_id = $2
        `,
        [
            installationId,
            communic8UserId
        ]
    );
}

export async function getValidZoomUserAccessToken(
    installationId: string,
    communic8UserId: number
): Promise<string> {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query<ZoomUserTokenRow>(
            `
            SELECT
                id,
                installation_id,
                communic8_user_id,
                zoom_user_id,
                access_token_encrypted,
                refresh_token_encrypted,
                access_token_expires_at,
                scope,
                token_type
            FROM zoom_user_oauth_tokens
            WHERE installation_id = $1
              AND communic8_user_id = $2
            FOR UPDATE
            `,
            [
                installationId,
                communic8UserId
            ]
        );

        if (result.rowCount !== 1) {
            throw new Error(
                'Zoom user OAuth connection not found'
            );
        }

        const row = result.rows[0];

        const expiresAt =
            new Date(row.access_token_expires_at);

        /*
         * Refresh slightly before actual expiry so a request
         * does not begin with a token that expires mid-call.
         */
        const refreshThreshold =
            Date.now() + 60_000;

        if (
            expiresAt.getTime() >
            refreshThreshold
        ) {
            const accessToken =
                decrypt(
                    row.access_token_encrypted
                );

            await client.query('COMMIT');

            return accessToken;
        }

        const refreshToken =
            decrypt(
                row.refresh_token_encrypted
            );

        const {
            clientId,
            clientSecret
        } = getZoomOAuthCredentials();

        const basicAuth = Buffer.from(
            `${clientId}:${clientSecret}`
        ).toString('base64');

        const response = await fetch(
            ZOOM_OAUTH_TOKEN_URL,
            {
                method: 'POST',
                headers: {
                    Authorization:
                        `Basic ${basicAuth}`,
                    'Content-Type':
                        'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type:
                        'refresh_token',
                    refresh_token:
                        refreshToken
                })
            }
        );

        const responseBody =
            await response
                .json()
                .catch(() => null) as
                | ZoomTokenResponse
                | null;

        if (
            !response.ok ||
            !responseBody?.access_token ||
            !responseBody.expires_in
        ) {
            throw new Error(
                `Zoom user token refresh failed with status ${response.status}`
            );
        }

        const newRefreshToken =
            responseBody.refresh_token ??
            refreshToken;

        const newExpiresAt =
            new Date(
                Date.now() +
                responseBody.expires_in *
                    1000
            );

        await client.query(
            `
            UPDATE zoom_user_oauth_tokens
            SET
                access_token_encrypted = $1,
                refresh_token_encrypted = $2,
                access_token_expires_at = $3,
                scope = COALESCE($4, scope),
                token_type =
                    COALESCE($5, token_type),
                updated_at = NOW()
            WHERE id = $6
            `,
            [
                encrypt(
                    responseBody.access_token
                ),
                encrypt(
                    newRefreshToken
                ),
                newExpiresAt,
                responseBody.scope ?? null,
                responseBody.token_type ?? null,
                row.id
            ]
        );

        await client.query('COMMIT');

        console.log(
            '[ZOOM USER TOKEN REFRESH SUCCESS]',
            {
                installationId,
                communic8UserId,
                zoomUserId:
                    row.zoom_user_id
            }
        );

        return responseBody.access_token;

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}