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

app.listen(PORT, HOST, () => {
    console.log(
        `Zoom Salesforce API listening on http://${HOST}:${PORT}`
    );
});