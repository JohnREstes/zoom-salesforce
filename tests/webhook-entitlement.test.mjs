import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual handlers without starting the server, workers, or a DB.
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const handlers = source.slice(
    source.indexOf('function verifyZoomWebhookSignature('),
    source.indexOf("app.post('/webhooks/zoom'")
);
const validator = source.slice(
    source.indexOf('function isSalesforceRecordId('),
    source.indexOf('function getSalesforceUserId(')
);
const code = ts.transpileModule(handlers + validator, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;
const installationId = '11111111-1111-4111-8111-111111111111';
const webhookKey = '22222222-2222-4222-8222-222222222222';
const eligible = {
    salesforce_user_id: '005000000000001AAA',
    is_active: true,
    is_sms_capable: true,
    is_communik8_enabled: true
};

async function invoke({ owner = { type: 'user', id: 'zoom-user' }, rows = [eligible],
    eventName = 'phone.sms_received', accountId = 'account', signatureValid = true,
    databaseFails = false } = {}) {
    const calls = { sessions: 0, syncs: 0, ownerQueries: 0, logs: [] };
    const context = vm.createContext({
        crypto, Buffer,
        process: { env: { ZOOM_WEBHOOK_SECRET: 'synthetic-test-secret' } },
        console: Object.fromEntries(['log', 'warn', 'error'].map(method => [method,
            (...args) => calls.logs.push(JSON.stringify(args))])),
        db: { query: async (sql, params) => {
            if (sql.includes('FROM installations')) {
                return { rowCount: 1, rows: [{ id: installationId, zoom_account_id: 'account' }] };
            }
            if (sql.includes('FROM communic8_users')) {
                calls.ownerQueries++;
                assert.match(sql, /installation_id = \$1/);
                assert.match(sql, /zoom_user_id = \$2/);
                assert.match(sql, /LIMIT 2/);
                assert.deepEqual(Array.from(params), [installationId, 'zoom-user']);
                if (databaseFails) throw new Error('Synthetic DB failure');
                return { rowCount: rows.length, rows };
            }
            return { rowCount: 0, rows: [] };
        } },
        ensureSmsSessionFromWebhook: async () => {
            calls.sessions++;
            return { smsSessionId: 1, created: true };
        },
        syncSmsMessagesForSession: async () => {
            calls.syncs++;
            return { messagesInserted: 0, messagesProcessed: 0, syncTokenSaved: true };
        }
    });
    vm.runInContext(code, context);
    const body = { event: eventName, payload: { account_id: accountId, object: {
        owner, session_id: 'session', message: 'PRIVATE_TEST_BODY',
        sender: { id: 'zoom-user', phone_number: 'PRIVATE_TEST_PHONE' }
    } } };
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = '1234567890';
    const signature = crypto.createHmac('sha256', 'synthetic-test-secret')
        .update(`v0:${timestamp}:${rawBody}`).digest('hex');
    const req = { body, rawBody, headers: {
        'x-zm-request-timestamp': timestamp,
        'x-zm-signature': signatureValid ? `v0=${signature}` : 'invalid'
    } };
    let status;
    const res = { sendStatus(value) { status = value; return this; },
        status(value) { status = value; return this; }, json() { return this; } };
    let error;
    try { await context.handleZoomWebhook(req, res, webhookKey); }
    catch (caught) { error = caught; }
    assert.ok(calls.logs.every(line => !line.includes('PRIVATE_TEST_')));
    return { ...calls, status, error };
}

for (const eventName of ['phone.sms_received', 'phone.sms_sent']) {
    test(`${eventName}: enabled owner proceeds`, async () => {
        const result = await invoke({ eventName });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 200);
        assert.equal(result.sessions, 1);
        assert.equal(result.syncs, 1);
    });
    for (const [name, options] of [
        ['missing owner', { owner: null }],
        ['missing owner ID', { owner: { type: 'user' } }],
        ['blank owner ID', { owner: { type: 'user', id: ' ' } }],
        ['shared owner', { owner: { type: 'callQueue', id: 'zoom-user' } }],
        ['unknown owner', { rows: [] }],
        ['ambiguous owner', { rows: [eligible, eligible] }],
        ['disabled owner', { rows: [{ ...eligible, is_communik8_enabled: false }] }],
        ['inactive owner', { rows: [{ ...eligible, is_active: false }] }],
        ['not SMS capable', { rows: [{ ...eligible, is_sms_capable: false }] }],
        ['unmapped owner', { rows: [{ ...eligible, salesforce_user_id: null }] }]
    ]) {
        test(`${eventName}: ${name} does not ingest`, async () => {
            const result = await invoke({ ...options, eventName });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 200);
            assert.equal(result.sessions, 0);
            assert.equal(result.syncs, 0);
        });
    }
}
test('invalid signature and wrong account stop before entitlement lookup', async () => {
    for (const [options, status] of [[{ signatureValid: false }, 401], [{ accountId: 'other' }, 403]]) {
        const result = await invoke(options);
        assert.equal(result.status, status);
        assert.equal(result.ownerQueries, 0);
        assert.equal(result.sessions, 0);
        assert.equal(result.syncs, 0);
    }
});
test('database failure propagates without ingestion', async () => {
    const result = await invoke({ databaseFails: true });
    assert.match(result.error.message, /Synthetic DB failure/);
    assert.equal(result.sessions, 0);
    assert.equal(result.syncs, 0);
});
