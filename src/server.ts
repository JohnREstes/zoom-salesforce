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
    ensureSmsSessionFromWebhook,
    cleanupEmptyWebhookSmsSession
} from './zoomSmsSyncService.js';

import { syncSmsMessagesForSession } from './zoomSmsMessageSyncService.js';

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
                } catch (error) {
                    const zoomError = error as Error & {
                        zoomCode?: number;
                        zoomStatus?: number;
                    };

                    if (zoomError.zoomCode === 12004) {
                        let cleanedUp = false;

                        if (created) {
                            cleanedUp =
                                await cleanupEmptyWebhookSmsSession(
                                    installation.id,
                                    smsSessionId
                                );
                        }

                        console.warn(
                            '[ZOOM SMS WEBHOOK SESSION NOT SYNCABLE]',
                            {
                                event: event.event,
                                installationId: installation.id,
                                smsSessionId,
                                zoomCode: zoomError.zoomCode,
                                cleanedUp
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

app.listen(PORT, HOST, () => {
    console.log(
        `Zoom Salesforce API listening on http://${HOST}:${PORT}`
    );
});