import crypto from 'crypto';

import { db } from './db.js';
import {
    encrypt,
    decrypt
} from './crypto.js';

type SalesforceOAuthAttempt = {
    installationId: string;
    state: string;
    codeChallenge: string;
    loginUrl: string;
};

type ConsumedSalesforceOAuthAttempt = {
    installationId: string;
    codeVerifier: string;
    loginUrl: string;
};

function base64UrlEncode(
    value: Buffer
): string {
    return value
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function hashState(
    state: string
): string {
    return crypto
        .createHash('sha256')
        .update(state)
        .digest('hex');
}

export async function createSalesforceOAuthAttempt(
    installationId: string,
    loginUrl = 'https://login.salesforce.com'
): Promise<SalesforceOAuthAttempt> {
    const state =
        base64UrlEncode(
            crypto.randomBytes(32)
        );

    const codeVerifier =
        base64UrlEncode(
            crypto.randomBytes(64)
        );

    const codeChallenge =
        base64UrlEncode(
            crypto
                .createHash('sha256')
                .update(codeVerifier)
                .digest()
        );

    const stateHash =
        hashState(state);

    const codeVerifierEncrypted =
        encrypt(codeVerifier);

    await db.query(
        `
        DELETE FROM salesforce_oauth_attempts
        WHERE expires_at < NOW()
        `
    );

    await db.query(
        `
        INSERT INTO salesforce_oauth_attempts (
            installation_id,
            state_hash,
            code_verifier_encrypted,
            login_url,
            expires_at
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            NOW() + INTERVAL '10 minutes'
        )
        `,
        [
            installationId,
            stateHash,
            codeVerifierEncrypted,
            loginUrl
        ]
    );

    return {
        installationId,
        state,
        codeChallenge,
        loginUrl
    };
}

export async function consumeSalesforceOAuthAttempt(
    state: string
): Promise<ConsumedSalesforceOAuthAttempt | null> {
    const stateHash =
        hashState(state);

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const result =
            await client.query(
                `
                DELETE FROM salesforce_oauth_attempts
                WHERE state_hash = $1
                  AND expires_at > NOW()
                RETURNING
                    installation_id,
                    code_verifier_encrypted,
                    login_url
                `,
                [stateHash]
            );

        if (result.rowCount !== 1) {
            await client.query('ROLLBACK');
            return null;
        }

        await client.query('COMMIT');

        return {
            installationId:
                result.rows[0].installation_id,

            codeVerifier:
                decrypt(
                    result.rows[0]
                        .code_verifier_encrypted
                ),

            loginUrl:
                result.rows[0].login_url
        };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve original error.
        }

        throw error;
    } finally {
        client.release();
    }
}