import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';

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

app.post('/webhooks/zoom', (req, res) => {
    const event = req.body;

    if (event?.event === 'endpoint.url_validation') {
        const plainToken = event?.payload?.plainToken;
        const secretToken = process.env.ZOOM_WEBHOOK_SECRET;

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

    console.log('[ZOOM WEBHOOK]', JSON.stringify(event));

    return res.sendStatus(200);
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
                    <h1>CommBeyond connected successfully</h1>
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