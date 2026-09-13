import { db } from './db.js';

export const COMMUNIK8_CAPABILITIES = {
    VIEW_ALL_MESSAGES: 'VIEW_ALL_MESSAGES'
} as const;

export type Communik8CapabilityKey =
    typeof COMMUNIK8_CAPABILITIES[
        keyof typeof COMMUNIK8_CAPABILITIES
    ];

export type Communik8UserCapability = {
    capabilityKey: string;
    isEnabled: boolean;
    grantedBy: string | null;
    grantedAt: string | null;
    expiresAt: string | null;
};

type CapabilityRow = {
    capability_key: string;
    is_enabled: boolean;
    granted_by: string | null;
    granted_at: Date | string | null;
    expires_at: Date | string | null;
};

function toIsoString(
    value: Date | string | null
): string | null {
    if (!value) {
        return null;
    }

    const date =
        value instanceof Date
            ? value
            : new Date(value);

    return Number.isNaN(date.getTime())
        ? null
        : date.toISOString();
}

/**
 * Returns true only when the exact user has an enabled, unexpired
 * capability within the same Communik8 installation.
 *
 * This is the backend authorization boundary for premium/elevated
 * Communik8 features. Callers should never infer capability from
 * Salesforce profile names, permission-set names, or UI state.
 */
export async function hasCommunik8UserCapability(
    installationId: string,
    communic8UserId: number,
    capabilityKey: Communik8CapabilityKey | string
): Promise<boolean> {
    const result = await db.query(
        `
        SELECT 1
        FROM communic8_user_capabilities
        WHERE installation_id = $1
          AND communic8_user_id = $2
          AND capability_key = $3
          AND is_enabled = TRUE
          AND (
              expires_at IS NULL
              OR expires_at > NOW()
          )
        LIMIT 1
        `,
        [
            installationId,
            communic8UserId,
            capabilityKey
        ]
    );

    return result.rowCount === 1;
}

/**
 * Returns all currently-effective capabilities for one Communik8 user.
 * Useful for future feature discovery without adding one endpoint per
 * capability.
 */
export async function getCommunik8UserCapabilities(
    installationId: string,
    communic8UserId: number
): Promise<Communik8UserCapability[]> {
    const result = await db.query<CapabilityRow>(
        `
        SELECT
            capability_key,
            is_enabled,
            granted_by,
            granted_at,
            expires_at
        FROM communic8_user_capabilities
        WHERE installation_id = $1
          AND communic8_user_id = $2
          AND is_enabled = TRUE
          AND (
              expires_at IS NULL
              OR expires_at > NOW()
          )
        ORDER BY capability_key ASC
        `,
        [
            installationId,
            communic8UserId
        ]
    );

    return result.rows.map(row => ({
        capabilityKey: row.capability_key,
        isEnabled: row.is_enabled,
        grantedBy: row.granted_by,
        grantedAt: toIsoString(row.granted_at),
        expiresAt: toIsoString(row.expires_at)
    }));
}

/**
 * Grants or re-enables a capability for one user.
 *
 * grantedBy should contain only a coarse source identifier such as
 * SALESFORCE_PERMISSION_SYNC, ADMIN, LICENSE, or SYSTEM. Do not store
 * secrets or message content here.
 */
export async function grantCommunik8UserCapability(
    installationId: string,
    communic8UserId: number,
    capabilityKey: Communik8CapabilityKey | string,
    grantedBy: string | null = null,
    expiresAt: Date | null = null
): Promise<void> {
    await db.query(
        `
        INSERT INTO communic8_user_capabilities (
            installation_id,
            communic8_user_id,
            capability_key,
            is_enabled,
            granted_by,
            granted_at,
            expires_at,
            created_at,
            updated_at
        )
        VALUES (
            $1,
            $2,
            $3,
            TRUE,
            $4,
            NOW(),
            $5,
            NOW(),
            NOW()
        )
        ON CONFLICT (
            installation_id,
            communic8_user_id,
            capability_key
        )
        DO UPDATE SET
            is_enabled = TRUE,
            granted_by = EXCLUDED.granted_by,
            granted_at = NOW(),
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
        `,
        [
            installationId,
            communic8UserId,
            capabilityKey,
            grantedBy,
            expiresAt
        ]
    );
}

/**
 * Revokes a capability without deleting the historical entitlement row.
 */
export async function revokeCommunik8UserCapability(
    installationId: string,
    communic8UserId: number,
    capabilityKey: Communik8CapabilityKey | string
): Promise<void> {
    await db.query(
        `
        UPDATE communic8_user_capabilities
        SET
            is_enabled = FALSE,
            expires_at = NULL,
            updated_at = NOW()
        WHERE installation_id = $1
          AND communic8_user_id = $2
          AND capability_key = $3
        `,
        [
            installationId,
            communic8UserId,
            capabilityKey
        ]
    );
}
