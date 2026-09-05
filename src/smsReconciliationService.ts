import { db } from './db.js';
import { syncSmsMessagesForSession } from './zoomSmsMessageSyncService.js';
import { publishCommunik8MessageEvent } from './salesforcePlatformEventService.js';
import {
    syncSmsSessionSnapshot,
    recoverSmsParticipantsFromMessages
} from './zoomSmsSyncService.js';

type ReconciliationSessionRow = {
    id: number;
    installation_id: string;
    salesforce_contact_id: string | null;
    salesforce_account_id: string | null;
};

const RECONCILIATION_INTERVAL_MS = 60_000;
const RECONCILIATION_BATCH_SIZE = 25;
const RECONCILIATION_LOOKBACK_HOURS = 24;

let reconciliationRunning = false;
let reconciliationTimer:
    ReturnType<typeof setInterval> | null = null;

async function getSessionsNeedingReconciliation():
Promise<ReconciliationSessionRow[]> {
    const result =
        await db.query<ReconciliationSessionRow>(
            `
            SELECT
                s.id,
                s.installation_id,
                s.salesforce_contact_id,
                s.salesforce_account_id
            FROM zoom_sms_sessions s
            WHERE
                s.last_access_time >=
                    NOW() - ($1 * INTERVAL '1 hour')

            AND (
                s.sync_token IS NULL

                OR NOT EXISTS (
                    SELECT 1
                    FROM zoom_sms_messages m
                    WHERE m.sms_session_id = s.id
                )

                OR NOT EXISTS (
                    SELECT 1
                    FROM zoom_sms_participants p
                    WHERE p.sms_session_id = s.id
                )
            )

                AND s.updated_at <=
                    NOW() - INTERVAL '30 seconds'

            ORDER BY
                s.created_at DESC,
                s.last_access_time DESC NULLS LAST,
                s.id DESC

            LIMIT $2
            `,
            [
                RECONCILIATION_LOOKBACK_HOURS,
                RECONCILIATION_BATCH_SIZE
            ]
        );

    return result.rows;
}

async function reconcileSmsSession(
    session: ReconciliationSessionRow
): Promise<void> {
    try {
        const syncResult =
            await syncSmsMessagesForSession(
                session.installation_id,
                session.id
            );

        const participantSyncResult =
            await syncSmsSessionSnapshot(
                session.installation_id,
                session.id
            );

        let participantRecoveryResult = {
            recovered: false,
            participantsProcessed:
                participantSyncResult.participantsProcessed
        };

        if (
            participantSyncResult.participantsProcessed === 0
        ) {
            participantRecoveryResult =
                await recoverSmsParticipantsFromMessages(
                    session.installation_id,
                    session.id
                );
        }

        /*
         * Re-read the session after synchronization because
         * syncSmsMessagesForSession may have just attached a
         * Salesforce Contact/Account.
         */
        const refreshedResult =
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
                    session.id,
                    session.installation_id
                ]
            );

        const refreshed =
            refreshedResult.rows[0];

        console.log('[SMS RECONCILIATION SUCCESS]', {
            installationId:
                session.installation_id,
            smsSessionId:
                session.id,
            messagesProcessed:
                syncResult.messagesProcessed,
            syncTokenSaved:
                syncResult.syncTokenSaved,
            participantSnapshotFound:
                participantSyncResult.found,
            participantsRecoveredFromMessage:
                participantRecoveryResult.recovered,
            participantsProcessed:
                Math.max(
                    participantSyncResult.participantsProcessed,
                    participantRecoveryResult.participantsProcessed
                ),
            hasSalesforceContact:
                Boolean(
                    refreshed?.salesforce_contact_id
                )
        });

        /*
         * If reconciliation produced a usable Salesforce
         * conversation, wake the Salesforce UI.
         *
         * The event carries routing metadata only.
         */
        if (
            refreshed?.salesforce_contact_id &&
            syncResult.messagesProcessed > 0
        ) {
            try {
                await publishCommunik8MessageEvent(
                    session.installation_id,
                    {
                        contactId:
                            refreshed.salesforce_contact_id,
                        accountId:
                            refreshed.salesforce_account_id,
                        smsSessionId:
                            session.id,
                        eventType:
                            'SMS_RECONCILED'
                    }
                );
            } catch {
                console.warn(
                    '[SMS RECONCILIATION PLATFORM EVENT FAILED]',
                    {
                        installationId:
                            session.installation_id,
                        smsSessionId:
                            session.id
                    }
                );
            }
        }
    } catch (error) {
        const zoomError =
            error as Error & {
                zoomCode?: number;
                zoomStatus?: number;
            };

        if (zoomError.zoomCode === 12004) {
            console.log(
                '[SMS RECONCILIATION SESSION NOT READY]',
                {
                    installationId:
                        session.installation_id,
                    smsSessionId:
                        session.id,
                    zoomCode:
                        zoomError.zoomCode
                }
            );

            return;
        }

        console.warn('[SMS RECONCILIATION FAILED]', {
            installationId:
                session.installation_id,
            smsSessionId:
                session.id,
            zoomCode:
                zoomError.zoomCode,
            zoomStatus:
                zoomError.zoomStatus
        });
    }
}

export async function runSmsReconciliation():
Promise<void> {
    if (reconciliationRunning) {
        console.log(
            '[SMS RECONCILIATION SKIPPED] Previous run still active'
        );

        return;
    }

    reconciliationRunning = true;

    try {
        const sessions =
            await getSessionsNeedingReconciliation();

        if (sessions.length === 0) {
            return;
        }

        console.log('[SMS RECONCILIATION START]', {
            sessionCount: sessions.length
        });

        /*
         * Run sequentially for now.
         *
         * This intentionally avoids creating a burst of Zoom
         * and Salesforce API requests.
         */
        for (const session of sessions) {
            await reconcileSmsSession(session);
        }

        console.log('[SMS RECONCILIATION COMPLETE]', {
            sessionCount: sessions.length
        });
    } catch (error) {
        console.error(
            '[SMS RECONCILIATION WORKER FAILED]',
            error
        );
    } finally {
        reconciliationRunning = false;
    }
}

export function startSmsReconciliationWorker():
void {
    if (reconciliationTimer) {
        return;
    }

    console.log('[SMS RECONCILIATION WORKER STARTED]', {
        intervalSeconds:
            RECONCILIATION_INTERVAL_MS / 1000,
        batchSize:
            RECONCILIATION_BATCH_SIZE,
        lookbackHours:
            RECONCILIATION_LOOKBACK_HOURS
    });

    /*
     * Give the application a few seconds to finish startup,
     * then perform the first reconciliation without waiting
     * a full minute.
     */
    setTimeout(() => {
        void runSmsReconciliation();
    }, 10_000);

    reconciliationTimer =
        setInterval(() => {
            void runSmsReconciliation();
        }, RECONCILIATION_INTERVAL_MS);
}