import 'dotenv/config';

import crypto from 'node:crypto';

type OAuthStatePayload = {
    installationId: string;
    issuedAt: number;
};

function getStateSecret(): string {
    const secret = process.env.OAUTH_STATE_SECRET;

    if (!secret) {
        throw new Error('OAUTH_STATE_SECRET is not configured');
    }

    return secret;
}

function base64UrlEncode(value: string): string {
    return Buffer
        .from(value, 'utf8')
        .toString('base64url');
}

function base64UrlDecode(value: string): string {
    return Buffer
        .from(value, 'base64url')
        .toString('utf8');
}

export function createOAuthState(
    installationId: string
): string {
    const payload: OAuthStatePayload = {
        installationId,
        issuedAt: Date.now()
    };

    const encodedPayload = base64UrlEncode(
        JSON.stringify(payload)
    );

    const signature = crypto
        .createHmac('sha256', getStateSecret())
        .update(encodedPayload)
        .digest('base64url');

    return `${encodedPayload}.${signature}`;
}

export function verifyOAuthState(
    state: string
): OAuthStatePayload | null {
    const [encodedPayload, providedSignature] =
        state.split('.');

    if (!encodedPayload || !providedSignature) {
        return null;
    }

    const expectedSignature = crypto
        .createHmac('sha256', getStateSecret())
        .update(encodedPayload)
        .digest('base64url');

    const expectedBuffer = Buffer.from(expectedSignature);
    const providedBuffer = Buffer.from(providedSignature);

    if (expectedBuffer.length !== providedBuffer.length) {
        return null;
    }

    if (
        !crypto.timingSafeEqual(
            expectedBuffer,
            providedBuffer
        )
    ) {
        return null;
    }

    try {
        const payload = JSON.parse(
            base64UrlDecode(encodedPayload)
        ) as OAuthStatePayload;

        if (
            !payload.installationId ||
            typeof payload.installationId !== 'string' ||
            typeof payload.issuedAt !== 'number'
        ) {
            return null;
        }

        const maxAgeMs = 10 * 60 * 1000;

        if (Date.now() - payload.issuedAt > maxAgeMs) {
            return null;
        }

        return payload;
    } catch {
        return null;
    }
}