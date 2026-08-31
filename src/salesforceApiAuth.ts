import crypto from 'crypto';
import { db } from './db.js';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hashApiKey(apiKey: string): string {
    return crypto
        .createHash('sha256')
        .update(apiKey, 'utf8')
        .digest('hex');
}

export function getBearerToken(
    authorizationHeader: string | undefined
): string | null {
    if (!authorizationHeader) {
        return null;
    }

    const match = authorizationHeader.match(
        /^Bearer\s+(.+)$/i
    );

    return match?.[1]?.trim() || null;
}

export async function authenticateSalesforceApiRequest(
    installationId: string | undefined,
    bearerToken: string | null
): Promise<string | null> {
    if (
        !installationId ||
        !UUID_PATTERN.test(installationId) ||
        !bearerToken ||
        bearerToken.length < 32
    ) {
        return null;
    }

    const apiKeyHash = hashApiKey(bearerToken);

    const result = await db.query(
        `
        SELECT i.id
        FROM installations i
        INNER JOIN salesforce_connections sc
            ON sc.installation_id = i.id
        WHERE i.id = $1
          AND i.salesforce_api_key_hash = $2
        LIMIT 1
        `,
        [
            installationId,
            apiKeyHash
        ]
    );

    return result.rowCount === 1
        ? result.rows[0].id
        : null;
}
