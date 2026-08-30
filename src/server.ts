import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';

import { saveZoomTokens } from './zoomTokenStore.js';
import { db } from './db.js';

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3050);
const HOST = process.env.HOST || '127.0.0.1';

app.use(helmet());
app.use(express.json());

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'zoom-salesforce-api',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    });
});

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

    // Installation-specific webhook
    if (webhookKey) {
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

        if (!code || typeof code !== 'string') {
            return res.status(400).send('Missing Zoom authorization code.');
        }

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

        await saveZoomTokens(tokenData);

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

app.listen(PORT, HOST, () => {
    console.log(
        `Zoom Salesforce API listening on http://${HOST}:${PORT}`
    );
});