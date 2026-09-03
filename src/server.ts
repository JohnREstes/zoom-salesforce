import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';

import { saveZoomTokens } from './zoomTokenStore.js';
import { db } from './db.js';

import {
    createOAuthState,
    verifyOAuthState
} from './oauthState.js';

import {
    ensureSmsSessionFromWebhook
} from './zoomSmsSyncService.js';

import { syncSmsMessagesForSession } from './zoomSmsMessageSyncService.js';

import {
    createSalesforceOAuthAttempt,
    consumeSalesforceOAuthAttempt
} from './salesforceOAuthService.js';

import {
    encrypt
} from './crypto.js';


import {
    authenticateSalesforceApiRequest,
    getBearerToken
} from './salesforceApiAuth.js';

import {
    getSmsConversationsForAccount,
    getSmsConversationsForContact
} from './salesforceSmsConversationService.js';

import {
    sendSmsForSalesforceContact
} from './salesforceSmsSendService.js';

import {
    publishCommunik8MessageEvent
} from './salesforcePlatformEventService.js';

import {
    createSmsTemplate,
    deleteSmsTemplate,
    getSmsTemplates,
    updateSmsTemplate,
    type SmsTemplateScope
} from './smsTemplateService.js';

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3050);
const HOST = process.env.HOST || '127.0.0.1';

app.use(helmet());
app.use(express.json({
    verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody =
            Buffer.from(buf);
    }
}));

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'zoom-salesforce-api',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    });
});

function verifyZoomWebhookSignature(req: express.Request): boolean {
    const secretToken = process.env.ZOOM_WEBHOOK_SECRET;
    const timestamp = req.headers['x-zm-request-timestamp'];
    const zoomSignature = req.headers['x-zm-signature'];

    if (
        !secretToken ||
        typeof timestamp !== 'string' ||
        typeof zoomSignature !== 'string'
    ) {
        return false;
    }

    const rawBody = (
        req as express.Request & { rawBody?: Buffer }
    ).rawBody;

    if (!rawBody) {
        return false;
    }

    const message = `v0:${timestamp}:${rawBody.toString('utf8')}`;

    const hash = crypto
        .createHmac('sha256', secretToken)
        .update(message)
        .digest('hex');

    const expectedSignature = `v0=${hash}`;

    const expectedBuffer = Buffer.from(expectedSignature);
    const receivedBuffer = Buffer.from(zoomSignature);

    if (expectedBuffer.length !== receivedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        expectedBuffer,
        receivedBuffer
    );
}

async function handleZoomWebhook(
    req: express.Request,
    res: express.Response,
    webhookKey?: string
) {
    const event = req.body;
    const secretToken = process.env.ZOOM_WEBHOOK_SECRET;

    // Zoom endpoint validation
    if (event?.event === 'endpoint.url_validation') {
        const plainToken = event?.payload?.plainToken;

        if (!plainToken || !secretToken) {
            return res.status(400).json({
                error: 'Missing webhook validation data'
            });
        }

        const encryptedToken = crypto
            .createHmac('sha256', secretToken)
            .update(plainToken)
            .digest('hex');

        return res.status(200).json({
            plainToken,
            encryptedToken
        });
    }

    if (!verifyZoomWebhookSignature(req)) {
        console.warn('[ZOOM WEBHOOK SIGNATURE INVALID]', {
            event: event?.event
        });

        return res.sendStatus(401);
    }

    // Installation-specific webhook
    if (webhookKey) {
        const uuidPattern =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

        if (!uuidPattern.test(webhookKey)) {
            return res.status(404).json({
                error: 'Unknown Communik8 installation'
            });
        }

        const installationResult = await db.query(
            `
            SELECT id, zoom_account_id
            FROM installations
            WHERE webhook_key = $1
            LIMIT 1
            `,
            [webhookKey]
        );

        if (installationResult.rowCount !== 1) {
            return res.status(404).json({
                error: 'Unknown Communik8 installation'
            });
        }

        const installation = installationResult.rows[0];
        const zoomAccountId = event?.payload?.account_id;

        if (zoomAccountId) {
            // Prevent an installation from silently changing
            // to a different Zoom account.
            if (
                installation.zoom_account_id &&
                installation.zoom_account_id !== zoomAccountId
            ) {
                console.error('[ZOOM WEBHOOK ACCOUNT MISMATCH]', {
                    installationId: installation.id
                });

                return res.sendStatus(403);
            }

            await db.query(
                `
                UPDATE installations
                SET
                    zoom_account_id = $1,
                    updated_at = NOW()
                WHERE id = $2
                  AND zoom_account_id IS NULL
                `,
                [zoomAccountId, installation.id]
            );

            await db.query(
                `
                UPDATE zoom_oauth_tokens
                SET
                    zoom_account_id = $1,
                    updated_at = NOW()
                WHERE installation_id = $2
                  AND zoom_account_id IS NULL
                `,
                [zoomAccountId, installation.id]
            );
        }

        if (
            typeof event?.event === 'string' &&
            (
                event.event === 'phone.sms_sent' ||
                event.event === 'phone.sms_received'
            )
        ) {
            const zoomSessionId =
                event?.payload?.object?.session_id;

            const messageDateTime =
                event?.payload?.object?.date_time;

            if (
                typeof zoomSessionId === 'string' &&
                zoomSessionId
            ) {
                const {
                    smsSessionId,
                    created
                } = await ensureSmsSessionFromWebhook(
                    installation.id,
                    zoomSessionId,
                    typeof messageDateTime === 'string'
                        ? messageDateTime
                        : undefined
                );

                try {
                    const syncResult =
                        await syncSmsMessagesForSession(
                            installation.id,
                            smsSessionId
                        );

                    console.log('[ZOOM SMS WEBHOOK SYNC]', {
                        event: event.event,
                        installationId: installation.id,
                        smsSessionId,
                        messagesProcessed:
                            syncResult.messagesProcessed,
                        syncTokenSaved:
                            syncResult.syncTokenSaved
                    });
                    if (
                        event.event === 'phone.sms_received'
                    ) {
                        try {
                            const matchResult =
                                await db.query<{
                                    salesforce_contact_id: string | null;
                                    salesforce_account_id: string | null;
                                }>(
                                    `
                                    SELECT
                                        salesforce_contact_id,
                                        salesforce_account_id
                                    FROM zoom_sms_sessions
                                    WHERE id = $1
                                    AND installation_id = $2
                                    LIMIT 1
                                    `,
                                    [
                                        smsSessionId,
                                        installation.id
                                    ]
                                );

                            const match =
                                matchResult.rows[0];

                            if (match?.salesforce_contact_id) {
                                await publishCommunik8MessageEvent(
                                    installation.id,
                                    {
                                        contactId:
                                            match.salesforce_contact_id,
                                        accountId:
                                            match.salesforce_account_id,
                                        smsSessionId,
                                        eventType: 'SMS_RECEIVED'
                                    }
                                );
                            } else {
                                console.log(
                                    '[SALESFORCE PLATFORM EVENT SKIPPED]',
                                    {
                                        installationId:
                                            installation.id,
                                        smsSessionId,
                                        reason:
                                            'No matched Salesforce Contact'
                                    }
                                );
                            }

                        } catch (error) {
                            /*
                            * Salesforce notification is best-effort.
                            *
                            * Never make Zoom retry a webhook just because
                            * Salesforce notification failed after the SMS
                            * was already synchronized successfully.
                            */
                            console.warn(
                                '[SALESFORCE PLATFORM EVENT NOTIFICATION FAILED]',
                                {
                                    installationId:
                                        installation.id,
                                    smsSessionId
                                }
                            );
                        }
                    }
                } catch (error) {
                    const zoomError = error as Error & {
                        zoomCode?: number;
                        zoomStatus?: number;
                    };

                if (zoomError.zoomCode === 12004) {
                    console.warn(
                        '[ZOOM SMS WEBHOOK SESSION TEMPORARILY UNAVAILABLE]',
                        {
                            event: event.event,
                            installationId: installation.id,
                            smsSessionId,
                            created,
                            zoomCode: zoomError.zoomCode
                        }
                    );
                } else {
                    throw error;
                }
                }
            } else {
                console.warn(
                    '[ZOOM SMS WEBHOOK MISSING SESSION ID]',
                    {
                        event: event.event,
                        installationId: installation.id
                    }
                );
            }
        }

        console.log('[ZOOM WEBHOOK]', {
            event: event?.event,
            installationId: installation.id,
            hasAccountId: Boolean(zoomAccountId)
        });

        return res.sendStatus(200);
    }

    // Temporary legacy endpoint while we transition Zoom
    // to installation-specific webhook URLs.
    console.log('[ZOOM WEBHOOK LEGACY]', {
        event: event?.event
    });

    return res.sendStatus(200);
}

app.post('/webhooks/zoom', async (req, res) => {
    try {
        return await handleZoomWebhook(req, res);
    } catch (error) {
        console.error('[ZOOM WEBHOOK ERROR]', error);
        return res.sendStatus(500);
    }
});

app.post('/webhooks/zoom/:webhookKey', async (req, res) => {
    try {
        return await handleZoomWebhook(
            req,
            res,
            req.params.webhookKey
        );
    } catch (error) {
        console.error('[ZOOM WEBHOOK ERROR]', error);
        return res.sendStatus(500);
    }
});

app.get('/auth/zoom/callback', async (req, res) => {
    try {
        const code = req.query.code;

        const state = req.query.state;

    if (!code || typeof code !== 'string') {
        return res.status(400).send(
            'Missing Zoom authorization code.'
        );
    }

    if (!state || typeof state !== 'string') {
        return res.status(400).send(
            'Missing OAuth state.'
        );
    }

    const statePayload = verifyOAuthState(state);

    if (!statePayload) {
        return res.status(400).send(
            'Invalid or expired OAuth state.'
        );
    }

    const installationId =
        statePayload.installationId;

        const clientId = process.env.ZOOM_CLIENT_ID;
        const clientSecret = process.env.ZOOM_CLIENT_SECRET;
        const redirectUri = process.env.ZOOM_REDIRECT_URI;

        if (!clientId || !clientSecret || !redirectUri) {
            console.error('[ZOOM OAUTH] Missing OAuth configuration');
            return res.status(500).send('Zoom OAuth is not configured.');
        }

        const basicAuth = Buffer
            .from(`${clientId}:${clientSecret}`)
            .toString('base64');

        const tokenUrl = new URL('https://zoom.us/oauth/token');
        tokenUrl.searchParams.set('grant_type', 'authorization_code');
        tokenUrl.searchParams.set('code', code);
        tokenUrl.searchParams.set('redirect_uri', redirectUri);

        const tokenResponse = await fetch(tokenUrl.toString(), {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok) {
            console.error('[ZOOM OAUTH ERROR]', tokenData);

            return res.status(500).json({
                error: 'Zoom OAuth token exchange failed'
            });
        }

        await saveZoomTokens(
            tokenData,
            installationId
        );

        console.log('[ZOOM OAUTH SUCCESS]', {
            expires_in: tokenData.expires_in,
            scope: tokenData.scope
        });

        return res.status(200).send(`
            <html>
                <body style="
                    font-family: Arial, sans-serif;
                    padding: 40px;
                    text-align: center;
                ">
                    <h1>Communik8 connected successfully</h1>
                    <p>Zoom Phone authorization was completed.</p>
                    <p>You can close this window.</p>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('[ZOOM OAUTH CALLBACK ERROR]', error);

        return res.status(500).send(
            'An unexpected error occurred while connecting Zoom.'
        );
    }
});

app.get('/auth/zoom/start/:installationId', async (req, res) => {
    try {
        const installationId = req.params.installationId;

        const uuidPattern =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

        if (!uuidPattern.test(installationId)) {
            return res.status(404).send(
                'Communik8 installation not found.'
            );
        }

        const installationResult = await db.query(
            `
            SELECT id
            FROM installations
            WHERE id = $1
            LIMIT 1
            `,
            [installationId]
        );

        if (installationResult.rowCount !== 1) {
            return res.status(404).send(
                'Communik8 installation not found.'
            );
        }

        const clientId = process.env.ZOOM_CLIENT_ID;
        const redirectUri = process.env.ZOOM_REDIRECT_URI;

        if (!clientId || !redirectUri) {
            return res.status(500).send(
                'Zoom OAuth is not configured.'
            );
        }

        const state = createOAuthState(installationId);

        const authorizeUrl =
            new URL('https://zoom.us/oauth/authorize');

        authorizeUrl.searchParams.set(
            'response_type',
            'code'
        );

        authorizeUrl.searchParams.set(
            'client_id',
            clientId
        );

        authorizeUrl.searchParams.set(
            'redirect_uri',
            redirectUri
        );

        authorizeUrl.searchParams.set(
            'state',
            state
        );

        return res.redirect(authorizeUrl.toString());
    } catch (error) {
        console.error('[ZOOM OAUTH START ERROR]', error);

        return res.status(500).send(
            'Unable to start Zoom authorization.'
        );
    }
});

app.get('/auth/salesforce/callback', async (req, res) => {
    try {
        const code = req.query.code;
        const state = req.query.state;

        if (!code || typeof code !== 'string') {
            return res.status(400).send(
                'Missing Salesforce authorization code.'
            );
        }

        if (!state || typeof state !== 'string') {
            return res.status(400).send(
                'Missing Salesforce OAuth state.'
            );
        }

        const oauthAttempt =
            await consumeSalesforceOAuthAttempt(state);

        if (!oauthAttempt) {
            return res.status(400).send(
                'Invalid or expired Salesforce OAuth state.'
            );
        }

        const clientId =
            process.env.SALESFORCE_CLIENT_ID;

        const clientSecret =
            process.env.SALESFORCE_CLIENT_SECRET;

        const redirectUri =
            process.env.SALESFORCE_REDIRECT_URI;

        if (
            !clientId ||
            !clientSecret ||
            !redirectUri
        ) {
            console.error(
                '[SALESFORCE OAUTH] Missing OAuth configuration'
            );

            return res.status(500).send(
                'Salesforce OAuth is not configured.'
            );
        }

        const tokenUrl =
            new URL(
                `${oauthAttempt.loginUrl}/services/oauth2/token`
            );

        const tokenBody =
            new URLSearchParams();

        tokenBody.set(
            'grant_type',
            'authorization_code'
        );

        tokenBody.set(
            'code',
            code
        );

        tokenBody.set(
            'client_id',
            clientId
        );

        tokenBody.set(
            'client_secret',
            clientSecret
        );

        tokenBody.set(
            'redirect_uri',
            redirectUri
        );

        tokenBody.set(
            'code_verifier',
            oauthAttempt.codeVerifier
        );

        const tokenResponse =
            await fetch(
                tokenUrl.toString(),
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/x-www-form-urlencoded'
                    },
                    body: tokenBody.toString()
                }
            );

        const tokenData =
            await tokenResponse.json() as {
                access_token?: string;
                refresh_token?: string;
                instance_url?: string;
                id?: string;
                token_type?: string;
                issued_at?: string;
                scope?: string;
                error?: string;
                error_description?: string;
            };

        if (
            !tokenResponse.ok ||
            !tokenData.access_token ||
            !tokenData.instance_url
        ) {
            console.error(
                '[SALESFORCE OAUTH TOKEN ERROR]',
                {
                    status: tokenResponse.status,
                    error: tokenData.error,
                    description:
                        tokenData.error_description
                }
            );

            return res.status(500).send(
                'Salesforce OAuth token exchange failed.'
            );
        }

        /*
         * Salesforce's identity URL contains the organization
         * and user IDs. Retrieve them from the authenticated
         * identity endpoint rather than parsing assumptions
         * into the token response.
         */
        let salesforceOrgId: string | null = null;
        let salesforceUserId: string | null = null;

        if (tokenData.id) {
            const identityResponse =
                await fetch(
                    tokenData.id,
                    {
                        headers: {
                            Authorization:
                                `Bearer ${tokenData.access_token}`
                        }
                    }
                );

            if (identityResponse.ok) {
                const identityData =
                    await identityResponse.json() as {
                        organization_id?: string;
                        user_id?: string;
                    };

                salesforceOrgId =
                    identityData.organization_id ?? null;

                salesforceUserId =
                    identityData.user_id ?? null;
            } else {
                console.warn(
                    '[SALESFORCE IDENTITY LOOKUP FAILED]',
                    {
                        status:
                            identityResponse.status
                    }
                );
            }
        }

        const accessTokenEncrypted =
            encrypt(tokenData.access_token);

        const refreshTokenEncrypted =
            tokenData.refresh_token
                ? encrypt(tokenData.refresh_token)
                : null;

        await db.query(
            `
            INSERT INTO salesforce_connections (
                installation_id,
                salesforce_org_id,
                salesforce_user_id,
                instance_url,
                access_token_encrypted,
                refresh_token_encrypted,
                scope
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7
            )
            ON CONFLICT (installation_id)
            DO UPDATE SET
                salesforce_org_id =
                    EXCLUDED.salesforce_org_id,
                salesforce_user_id =
                    EXCLUDED.salesforce_user_id,
                instance_url =
                    EXCLUDED.instance_url,
                access_token_encrypted =
                    EXCLUDED.access_token_encrypted,
                refresh_token_encrypted =
                    COALESCE(
                        EXCLUDED.refresh_token_encrypted,
                        salesforce_connections
                            .refresh_token_encrypted
                    ),
                scope =
                    EXCLUDED.scope,
                updated_at = NOW()
            `,
            [
                oauthAttempt.installationId,
                salesforceOrgId,
                salesforceUserId,
                tokenData.instance_url,
                accessTokenEncrypted,
                refreshTokenEncrypted,
                tokenData.scope ?? null
            ]
        );

        console.log(
            '[SALESFORCE OAUTH SUCCESS]',
            {
                installationId:
                    oauthAttempt.installationId,
                hasOrgId:
                    Boolean(salesforceOrgId),
                hasUserId:
                    Boolean(salesforceUserId),
                hasRefreshToken:
                    Boolean(tokenData.refresh_token)
            }
        );

        return res.status(200).send(`
            <html>
                <body style="
                    font-family: Arial, sans-serif;
                    padding: 40px;
                    text-align: center;
                ">
                    <h1>Communik8 connected successfully</h1>
                    <p>
                        Salesforce authorization was completed.
                    </p>
                    <p>You can close this window.</p>
                </body>
            </html>
        `);
    } catch (error) {
        console.error(
            '[SALESFORCE OAUTH CALLBACK ERROR]',
            error
        );

        return res.status(500).send(
            'An unexpected error occurred while connecting Salesforce.'
        );
    }
});

app.get(
    '/auth/salesforce/start/:installationId',
    async (req, res) => {
        try {
            const installationId =
                req.params.installationId;

            const uuidPattern =
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

            if (!uuidPattern.test(installationId)) {
                return res.status(404).send(
                    'Communik8 installation not found.'
                );
            }

            const installationResult =
                await db.query(
                    `
                    SELECT id
                    FROM installations
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [installationId]
                );

            if (installationResult.rowCount !== 1) {
                return res.status(404).send(
                    'Communik8 installation not found.'
                );
            }

            const clientId =
                process.env.SALESFORCE_CLIENT_ID;

            const redirectUri =
                process.env.SALESFORCE_REDIRECT_URI;

            if (!clientId || !redirectUri) {
                return res.status(500).send(
                    'Salesforce OAuth is not configured.'
                );
            }

            const oauthAttempt =
                await createSalesforceOAuthAttempt(
                    installationId
                );

            const authorizeUrl =
                new URL(
                    `${oauthAttempt.loginUrl}/services/oauth2/authorize`
                );

            authorizeUrl.searchParams.set(
                'response_type',
                'code'
            );

            authorizeUrl.searchParams.set(
                'client_id',
                clientId
            );

            authorizeUrl.searchParams.set(
                'redirect_uri',
                redirectUri
            );

            authorizeUrl.searchParams.set(
                'state',
                oauthAttempt.state
            );

            authorizeUrl.searchParams.set(
                'code_challenge',
                oauthAttempt.codeChallenge
            );

            authorizeUrl.searchParams.set(
                'code_challenge_method',
                'S256'
            );

            return res.redirect(
                authorizeUrl.toString()
            );
        } catch (error) {
            console.error(
                '[SALESFORCE OAUTH START ERROR]',
                error
            );

            return res.status(500).send(
                'Unable to start Salesforce authorization.'
            );
        }
    }
);


function isSalesforceRecordId(value: string): boolean {
    return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}

function getSalesforceUserId(
    req: express.Request
): string | null {
    const value =
        req.headers['x-communik8-salesforce-user-id'];

    if (
        typeof value !== 'string' ||
        !isSalesforceRecordId(value)
    ) {
        return null;
    }

    return value;
}

async function resolveSalesforceApiInstallation(
    req: express.Request
): Promise<string | null> {
    const installationHeader =
        req.headers['x-communik8-installation-id'];

    const installationId =
        typeof installationHeader === 'string'
            ? installationHeader
            : undefined;

    const authorizationHeader =
        typeof req.headers.authorization === 'string'
            ? req.headers.authorization
            : undefined;

    return authenticateSalesforceApiRequest(
        installationId,
        getBearerToken(authorizationHeader)
    );
}

function parsePositiveIntegerQuery(
    value: unknown
): number | undefined {
    if (typeof value !== 'string' || !value) {
        return undefined;
    }

    const parsed = Number(value);

    if (
        !Number.isInteger(parsed) ||
        parsed < 1
    ) {
        return undefined;
    }

    return parsed;
}

app.get(
    '/api/salesforce/sms/templates',
    async (req, res) => {
        try {
            const installationId =
                await resolveSalesforceApiInstallation(req);

            if (!installationId) {
                return res.status(401).json({
                    error: 'Unauthorized'
                });
            }

            const salesforceUserId =
                getSalesforceUserId(req);

            if (!salesforceUserId) {
                return res.status(400).json({
                    error: 'Salesforce User ID is required'
                });
            }

            const templates =
                await getSmsTemplates(
                    installationId,
                    salesforceUserId
                );

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            return res.json({
                templateCount: templates.length,
                templates
            });

        } catch (error) {
            console.error(
                '[SALESFORCE SMS TEMPLATES ERROR]',
                error
            );

            return res.status(500).json({
                error: 'Unable to load SMS templates'
            });
        }
    }
);

app.post(
    '/api/salesforce/sms/templates',
    async (req, res) => {
        try {
            const installationId =
                await resolveSalesforceApiInstallation(req);

            if (!installationId) {
                return res.status(401).json({
                    error: 'Unauthorized'
                });
            }

            const salesforceUserId =
                getSalesforceUserId(req);

            if (!salesforceUserId) {
                return res.status(400).json({
                    error: 'Salesforce User ID is required'
                });
            }

            const name =
                typeof req.body?.name === 'string'
                    ? req.body.name.trim()
                    : '';

            const body =
                typeof req.body?.body === 'string'
                    ? req.body.body.trim()
                    : '';

            if (!name) {
                return res.status(400).json({
                    error: 'Template name is required'
                });
            }

            if (!body) {
                return res.status(400).json({
                    error: 'Template body is required'
                });
            }

            if (name.length > 150) {
                return res.status(400).json({
                    error: 'Template name is too long'
                });
            }

            if (body.length > 2000) {
                return res.status(400).json({
                    error: 'Template body is too long'
                });
            }

            const template =
                await createSmsTemplate(
                    installationId,
                    salesforceUserId,
                    'PERSONAL',
                    name,
                    body
                );

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            return res.status(201).json({
                success: true,
                template
            });

        } catch (error) {
            console.error(
                '[SALESFORCE SMS TEMPLATE CREATE ERROR]',
                error
            );

            const message =
                error instanceof Error
                    ? error.message
                    : '';

            if (
                message.includes('duplicate key') ||
                message.includes('unique constraint')
            ) {
                return res.status(409).json({
                    error:
                        'A personal template with that name already exists'
                });
            }

            return res.status(500).json({
                error: 'Unable to create SMS template'
            });
        }
    }
);

app.get(
    '/api/salesforce/sms/contacts/:contactId/conversations',
    async (req, res) => {
        try {
            const installationId =
                await resolveSalesforceApiInstallation(req);

            if (!installationId) {
                return res.status(401).json({
                    error: 'Unauthorized'
                });
            }

            const contactId = req.params.contactId;

            if (!isSalesforceRecordId(contactId)) {
                return res.status(400).json({
                    error: 'Invalid Salesforce Contact ID'
                });
            }

            const conversations =
                await getSmsConversationsForContact(
                    installationId,
                    contactId,
                    {
                        sessionLimit:
                            parsePositiveIntegerQuery(
                                req.query.sessionLimit
                            ),
                        messageLimitPerSession:
                            parsePositiveIntegerQuery(
                                req.query.messageLimit
                            )
                    }
                );

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            return res.json({
                contactId,
                conversationCount:
                    conversations.length,
                conversations
            });
        } catch (error) {
            console.error(
                '[SALESFORCE SMS CONTACT CONVERSATIONS ERROR]',
                error
            );

            return res.status(500).json({
                error: 'Unable to load SMS conversations'
            });
        }
    }
);

app.post(
    '/api/salesforce/sms/contacts/:contactId/messages',
    async (req, res) => {
        try {
            const installationId =
                await resolveSalesforceApiInstallation(req);

            if (!installationId) {
                return res.status(401).json({
                    error: 'Unauthorized'
                });
            }

            const contactId = req.params.contactId;

            if (!isSalesforceRecordId(contactId)) {
                return res.status(400).json({
                    error: 'Invalid Salesforce Contact ID'
                });
            }

            const message =
                typeof req.body?.message === 'string'
                    ? req.body.message.trim()
                    : '';

            if (!message) {
                return res.status(400).json({
                    error: 'Message is required'
                });
            }

            if (message.length > 2000) {
                return res.status(400).json({
                    error: 'Message is too long'
                });
            }

            const result =
                await sendSmsForSalesforceContact(
                    installationId,
                    contactId,
                    message
                );

            /*
             * Pull the sent message back through Zoom sync so
             * Communik8's local conversation history remains
             * authoritative immediately after sending.
             */
            try {
                await syncSmsMessagesForSession(
                    installationId,
                    result.smsSessionId
                );
            } catch (syncError) {
                console.warn(
                    '[SALESFORCE SMS POST-SEND SYNC FAILED]',
                    {
                        installationId,
                        smsSessionId:
                            result.smsSessionId
                    }
                );
            }

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            return res.status(201).json({
                success: true,
                smsSessionId:
                    result.smsSessionId,
                zoomMessageId:
                    result.zoomMessageId
            });
        } catch (error) {
            console.error(
                '[SALESFORCE SMS SEND ERROR]',
                error
            );

            const message =
                error instanceof Error
                    ? error.message
                    : '';

            if (
                message.includes(
                    'No matched SMS conversation'
                )
            ) {
                return res.status(404).json({
                    error:
                        'No SMS conversation found for Contact'
                });
            }

            if (
                message.includes(
                    'one-to-one conversation'
                ) ||
                message.includes(
                    'exactly one sender'
                )
            ) {
                return res.status(409).json({
                    error:
                        'SMS conversation cannot be safely resolved'
                });
            }

            return res.status(500).json({
                error: 'Unable to send SMS message'
            });
        }
    }
);

app.get(
    '/api/salesforce/sms/accounts/:accountId/conversations',
    async (req, res) => {
        try {
            const installationId =
                await resolveSalesforceApiInstallation(req);

            if (!installationId) {
                return res.status(401).json({
                    error: 'Unauthorized'
                });
            }

            const accountId = req.params.accountId;

            if (!isSalesforceRecordId(accountId)) {
                return res.status(400).json({
                    error: 'Invalid Salesforce Account ID'
                });
            }

            const conversations =
                await getSmsConversationsForAccount(
                    installationId,
                    accountId,
                    {
                        sessionLimit:
                            parsePositiveIntegerQuery(
                                req.query.sessionLimit
                            ),
                        messageLimitPerSession:
                            parsePositiveIntegerQuery(
                                req.query.messageLimit
                            )
                    }
                );

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            return res.json({
                accountId,
                conversationCount:
                    conversations.length,
                conversations
            });
        } catch (error) {
            console.error(
                '[SALESFORCE SMS ACCOUNT CONVERSATIONS ERROR]',
                error
            );

            return res.status(500).json({
                error: 'Unable to load SMS conversations'
            });
        }
    }
);



app.listen(PORT, HOST, () => {
    console.log(
        `Zoom Salesforce API listening on http://${HOST}:${PORT}`
    );
});