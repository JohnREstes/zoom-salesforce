import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { encrypt } from './crypto.js';

export async function saveZoomTokens(tokenData: any) {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const installationId = randomUUID();

        await client.query(
            `
            INSERT INTO installations (
                id,
                name
            )
            VALUES ($1, $2)
            `,
            [
                installationId,
                'Communik8 Zoom Installation'
            ]
        );

        const accessTokenExpiresAt = new Date(
            Date.now() + Number(tokenData.expires_in) * 1000
        );

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