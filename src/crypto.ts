// src/crypto.ts
import crypto from 'crypto';

const algorithm = 'aes-256-gcm';

function getKey(): Buffer {
    const hexKey = process.env.TOKEN_ENCRYPTION_KEY;

    if (!hexKey) {
        throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
    }

    const key = Buffer.from(hexKey, 'hex');

    if (key.length !== 32) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes');
    }

    return key;
}

export function encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(algorithm, getKey(), iv);

    const encrypted = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return [
        iv.toString('hex'),
        authTag.toString('hex'),
        encrypted.toString('hex')
    ].join(':');
}

export function decrypt(value: string): string {
    const [ivHex, authTagHex, encryptedHex] = value.split(':');

    if (!ivHex || !authTagHex || !encryptedHex) {
        throw new Error('Invalid encrypted token format');
    }

    const decipher = crypto.createDecipheriv(
        algorithm,
        getKey(),
        Buffer.from(ivHex, 'hex')
    );

    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, 'hex')),
        decipher.final()
    ]);

    return decrypted.toString('utf8');
}