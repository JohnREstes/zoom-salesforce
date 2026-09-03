import { pool } from './db';

export type SmsTemplateScope = 'PERSONAL' | 'SHARED';

export interface SmsTemplate {
    id: string;
    installationId: string;
    scope: SmsTemplateScope;
    name: string;
    body: string;
    createdBySalesforceUserId: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

interface SmsTemplateRow {
    id: string;
    installation_id: string;
    scope: SmsTemplateScope;
    name: string;
    body: string;
    created_by_salesforce_user_id: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

function mapTemplate(row: SmsTemplateRow): SmsTemplate {
    return {
        id: row.id,
        installationId: row.installation_id,
        scope: row.scope,
        name: row.name,
        body: row.body,
        createdBySalesforceUserId: row.created_by_salesforce_user_id,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}

export async function getSmsTemplates(
    installationId: string,
    salesforceUserId: string
): Promise<SmsTemplate[]> {
    const result = await pool.query<SmsTemplateRow>(
        `
        SELECT
            id,
            installation_id,
            scope,
            name,
            body,
            created_by_salesforce_user_id,
            is_active,
            created_at,
            updated_at
        FROM sms_templates
        WHERE installation_id = $1
          AND is_active = TRUE
          AND (
                scope = 'SHARED'
                OR (
                    scope = 'PERSONAL'
                    AND created_by_salesforce_user_id = $2
                )
          )
        ORDER BY
            CASE WHEN scope = 'SHARED' THEN 0 ELSE 1 END,
            LOWER(name),
            created_at
        `,
        [installationId, salesforceUserId]
    );

    return result.rows.map(mapTemplate);
}

export async function createSmsTemplate(
    installationId: string,
    salesforceUserId: string,
    scope: SmsTemplateScope,
    name: string,
    body: string
): Promise<SmsTemplate> {
    const safeName = name.trim();
    const safeBody = body.trim();

    if (!safeName) {
        throw new Error('Template name is required.');
    }

    if (!safeBody) {
        throw new Error('Template body is required.');
    }

    if (scope !== 'PERSONAL' && scope !== 'SHARED') {
        throw new Error('Invalid template scope.');
    }

    const result = await pool.query<SmsTemplateRow>(
        `
        INSERT INTO sms_templates (
            installation_id,
            scope,
            name,
            body,
            created_by_salesforce_user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            installation_id,
            scope,
            name,
            body,
            created_by_salesforce_user_id,
            is_active,
            created_at,
            updated_at
        `,
        [
            installationId,
            scope,
            safeName,
            safeBody,
            salesforceUserId
        ]
    );

    return mapTemplate(result.rows[0]);
}

export async function updateSmsTemplate(
    installationId: string,
    salesforceUserId: string,
    templateId: string,
    name: string,
    body: string
): Promise<SmsTemplate> {
    const safeName = name.trim();
    const safeBody = body.trim();

    if (!safeName) {
        throw new Error('Template name is required.');
    }

    if (!safeBody) {
        throw new Error('Template body is required.');
    }

    const result = await pool.query<SmsTemplateRow>(
        `
        UPDATE sms_templates
        SET
            name = $4,
            body = $5,
            updated_at = NOW()
        WHERE id = $1
          AND installation_id = $2
          AND is_active = TRUE
          AND (
                scope = 'SHARED'
                OR (
                    scope = 'PERSONAL'
                    AND created_by_salesforce_user_id = $3
                )
          )
        RETURNING
            id,
            installation_id,
            scope,
            name,
            body,
            created_by_salesforce_user_id,
            is_active,
            created_at,
            updated_at
        `,
        [
            templateId,
            installationId,
            salesforceUserId,
            safeName,
            safeBody
        ]
    );

    if (result.rowCount === 0) {
        throw new Error('Template not found or access denied.');
    }

    return mapTemplate(result.rows[0]);
}

export async function deleteSmsTemplate(
    installationId: string,
    salesforceUserId: string,
    templateId: string
): Promise<void> {
    const result = await pool.query(
        `
        UPDATE sms_templates
        SET
            is_active = FALSE,
            updated_at = NOW()
        WHERE id = $1
          AND installation_id = $2
          AND is_active = TRUE
          AND (
                scope = 'SHARED'
                OR (
                    scope = 'PERSONAL'
                    AND created_by_salesforce_user_id = $3
                )
          )
        `,
        [
            templateId,
            installationId,
            salesforceUserId
        ]
    );

    if (result.rowCount === 0) {
        throw new Error('Template not found or access denied.');
    }
}