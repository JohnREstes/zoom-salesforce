import crypto from 'crypto';

import { db } from './db.js';

type ZoomUserOAuthAttempt = {
    state: string;
};

export type ConsumedZoomUserOAuthAttempt = {
    installationId: string;
    communic8UserId: number;
    salesforceUserId: string;
    expectedZoomUserId: string;
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

/**
 * Creates a short-lived, single-use OAuth state for an
 * individual Communik8 user's Zoom authorization.
 *
 * The Salesforce and Zoom identities are snapshotted here
 * so the callback can verify that the same mapped Zoom user
 * completed the authorization.
 */
export async function createZoomUserOAuthAttempt(
    options: {
        installationId: string;
        communic8UserId: number;
        salesforceUserId: string;
        expectedZoomUserId: string;
    }
): Promise<ZoomUserOAuthAttempt> {
    const state =
        base64UrlEncode(
            crypto.randomBytes(32)
        );

    const stateHash =
        hashState(state);

    const client =
        await db.connect();

    try {
        await client.query('BEGIN');

        /*
         * Remove expired attempts globally.
         */
        await client.query(
            `
            DELETE FROM zoom_user_oauth_attempts
            WHERE expires_at < NOW()
            `
        );

        /*
         * Only one active authorization attempt is useful
         * for a given Communik8 user.
         */
        await client.query(
            `
            DELETE FROM zoom_user_oauth_attempts
            WHERE installation_id = $1
              AND communic8_user_id = $2
            `,
            [
                options.installationId,
                options.communic8UserId
            ]
        );

        await client.query(
            `
            INSERT INTO zoom_user_oauth_attempts (
                installation_id,
                communic8_user_id,
                salesforce_user_id,
                expected_zoom_user_id,
                state_hash,
                expires_at
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                NOW() + INTERVAL '10 minutes'
            )
            `,
            [
                options.installationId,
                options.communic8UserId,
                options.salesforceUserId,
                options.expectedZoomUserId,
                stateHash
            ]
        );

        await client.query('COMMIT');

        return {
            state
        };
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

/**
 * Atomically consumes an OAuth state.
 *
 * DELETE ... RETURNING makes the state single-use:
 * once consumed successfully, replaying the callback
 * with the same state cannot succeed.
 */
export async function consumeZoomUserOAuthAttempt(
    state: string
): Promise<ConsumedZoomUserOAuthAttempt | null> {
    const stateHash =
        hashState(state);

    const client =
        await db.connect();

    try {
        await client.query('BEGIN');

        const result =
            await client.query(
                `
                DELETE FROM zoom_user_oauth_attempts
                WHERE state_hash = $1
                  AND expires_at > NOW()
                RETURNING
                    installation_id,
                    communic8_user_id,
                    salesforce_user_id,
                    expected_zoom_user_id
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
                result.rows[0]
                    .installation_id,

            communic8UserId:
                Number(
                    result.rows[0]
                        .communic8_user_id
                ),

            salesforceUserId:
                result.rows[0]
                    .salesforce_user_id,

            expectedZoomUserId:
                result.rows[0]
                    .expected_zoom_user_id
        };
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