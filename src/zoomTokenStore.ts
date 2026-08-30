// src/zoomTokenStore.ts
import { db } from './db.js';
import { encrypt } from './crypto.js';

type ZoomTokenData = {
    account_id?: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
    token_type?: string;
};

export async function saveZoomTokens(tokenData: ZoomTokenData) {
    const expiresAt = new Date(
        Date.now() + tokenData.expires_in * 1000
    );

    await db.query(
        `
        INSERT INTO zoom_oauth_tokens (
            zoom_account_id,
            access_token_encrypted,
            refresh_token_encrypted,
            access_token_expires_at,
            scope,
            token_type
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
            tokenData.account_id ?? null,
            encrypt(tokenData.access_token),
            encrypt(tokenData.refresh_token),
            expiresAt,
            tokenData.scope ?? null,
            tokenData.token_type ?? null
        ]
    );
}