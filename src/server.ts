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

app.listen(PORT, HOST, () => {
    console.log(
        `Zoom Salesforce API listening on http://${HOST}:${PORT}`
    );
});