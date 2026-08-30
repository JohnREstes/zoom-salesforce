import 'dotenv/config';

import { db } from './db.js';
import { encrypt } from './crypto.js';

export async function saveZoomTokens(
    tokenData: any,
    installationId: string
) {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const installationResult = await client.query(
            `
            SELECT id
            FROM installations
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
            `,
            [installationId]
        );

        if (installationResult.rowCount !== 1) {
            throw new Error(
                'Communik8 installation not found'
            );
        }

        const accessTokenExpiresAt = new Date(
            Date.now() + Number(tokenData.expires_in) * 1000
        );

        const existingTokenResult = await client.query(
            `
            SELECT id
            FROM zoom_oauth_tokens
            WHERE installation_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
            `,
            [installationId]
        );

        if (existingTokenResult.rowCount === 1) {
            await client.query(
                `
                UPDATE zoom_oauth_tokens
                SET
                    access_token_encrypted = $1,
                    refresh_token_encrypted = $2,
                    access_token_expires_at = $3,
                    scope = $4,
                    token_type = $5,
                    updated_at = NOW()
                WHERE id = $6
                `,
                [
                    encrypt(tokenData.access_token),
                    encrypt(tokenData.refresh_token),
                    accessTokenExpiresAt,
                    tokenData.scope ?? null,
                    tokenData.token_type ?? null,
                    existingTokenResult.rows[0].id
                ]
            );
        } else {
            await client.query(
                `
                INSERT INTO zoom_oauth_tokens (
                    installation_id,
                    zoom_account_id,
                    access_token_encrypted,
                    refresh_token_encrypted,
                    access_token_expires_at,
                    scope,
                    token_type
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                `,
                [
                    installationId,
                    tokenData.account_id ?? null,
                    encrypt(tokenData.access_token),
                    encrypt(tokenData.refresh_token),
                    accessTokenExpiresAt,
                    tokenData.scope ?? null,
                    tokenData.token_type ?? null
                ]
            );
        }

        await client.query(
            `
            UPDATE installations
            SET updated_at = NOW()
            WHERE id = $1
            `,
            [installationId]
        );

        await client.query('COMMIT');

        return {
            installationId
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}