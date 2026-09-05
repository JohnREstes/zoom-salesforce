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

const PRIORITY_RECONCILIATION_INTERVAL_MS = 10_000;
const PRIORITY_RECONCILIATION_BATCH_SIZE = 10;
const CLEANUP_RECONCILIATION_INTERVAL_MS = 60_000;
const CLEANUP_RECONCILIATION_BATCH_SIZE = 25;
const RECONCILIATION_LOOKBACK_HOURS = 24;

let priorityReconciliationRunning = false;
let cleanupReconciliationRunning = false;

let priorityReconciliationTimer:
    ReturnType<typeof setInterval> | null = null;

let cleanupReconciliationTimer:
    ReturnType<typeof setInterval> | null = null;

async function getSessionsNeedingReconciliation(
    mode: 'priority' | 'cleanup'
): Promise<ReconciliationSessionRow[]> {
    const priorityOnly = mode === 'priority';
    const minimumAgeSeconds = priorityOnly ? 5 : 30;
    const batchSize = priorityOnly
        ? PRIORITY_RECONCILIATION_BATCH_SIZE
        : CLEANUP_RECONCILIATION_BATCH_SIZE;

    const result =
        await db.query<ReconciliationSessionRow>(
            `
            SELECT
                s.id,
                s.installation_id,
                s.salesforce_contact_id,
                s.salesforce_account_id,
                (
                    s.reconcile_until IS NOT NULL
                    AND s.reconcile_until > NOW()
                ) AS is_priority_reconciliation,
                EXISTS (
                    SELECT 1
                    FROM zoom_sms_participants existing_participant
                    WHERE existing_participant.sms_session_id = s.id
                ) AS has_participants
            FROM zoom_sms_sessions s
            WHERE
                s.last_access_time >=
                    NOW() - ($1 * INTERVAL '1 hour')

                AND (
                    (
                        $2::boolean = TRUE
                        AND s.reconcile_until > NOW()
                    )
                    OR
                    (
                        $2::boolean = FALSE
                        AND (
                            s.reconcile_until IS NULL
                            OR s.reconcile_until <= NOW()
                        )
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
                    )
                )

                AND s.updated_at <=
                    NOW() - ($3 * INTERVAL '1 second')

            ORDER BY
                CASE
                    WHEN $2::boolean = TRUE
                    THEN s.reconcile_until
                    ELSE s.created_at
                END DESC NULLS LAST,
                s.last_access_time DESC NULLS LAST,
                s.id DESC

            LIMIT $4
            `,
            [
                RECONCILIATION_LOOKBACK_HOURS,
                priorityOnly,
                minimumAgeSeconds,
                batchSize
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
            messagesInserted:
                syncResult.messagesInserted,
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
            syncResult.messagesInserted > 0
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

async function runPrioritySmsReconciliation():
Promise<void> {
    if (priorityReconciliationRunning) {
        return;
    }

    priorityReconciliationRunning = true;

    try {
        const sessions =
            await getSessionsNeedingReconciliation('priority');

        if (sessions.length === 0) {
            return;
        }

        console.log('[SMS PRIORITY RECONCILIATION START]', {
            sessionCount: sessions.length
        });

        for (const session of sessions) {
            await reconcileSmsSession(session);
        }

        console.log('[SMS PRIORITY RECONCILIATION COMPLETE]', {
            sessionCount: sessions.length
        });
    } catch (error) {
        console.error(
            '[SMS PRIORITY RECONCILIATION WORKER FAILED]',
            error
        );
    } finally {
        priorityReconciliationRunning = false;
    }
}

export async function runSmsReconciliation():
Promise<void> {
    if (cleanupReconciliationRunning) {
        console.log(
            '[SMS RECONCILIATION SKIPPED] Previous cleanup run still active'
        );

        return;
    }

    cleanupReconciliationRunning = true;

    try {
        const sessions =
            await getSessionsNeedingReconciliation('cleanup');

        if (sessions.length === 0) {
            return;
        }

        console.log('[SMS RECONCILIATION START]', {
            sessionCount: sessions.length
        });

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
        cleanupReconciliationRunning = false;
    }
}

export function startSmsReconciliationWorker():
void {
    if (
        priorityReconciliationTimer ||
        cleanupReconciliationTimer
    ) {
        return;
    }

    console.log('[SMS RECONCILIATION WORKER STARTED]', {
        priorityIntervalSeconds:
            PRIORITY_RECONCILIATION_INTERVAL_MS / 1000,
        priorityBatchSize:
            PRIORITY_RECONCILIATION_BATCH_SIZE,
        cleanupIntervalSeconds:
            CLEANUP_RECONCILIATION_INTERVAL_MS / 1000,
        cleanupBatchSize:
            CLEANUP_RECONCILIATION_BATCH_SIZE,
        lookbackHours:
            RECONCILIATION_LOOKBACK_HOURS
    });

    /*
     * Priority reconciliation is the real-time recovery lane.
     * It only touches sessions with an active reconcile_until
     * window and is intentionally independent from cleanup work.
     */
    setTimeout(() => {
        void runPrioritySmsReconciliation();
    }, 5_000);

    priorityReconciliationTimer =
        setInterval(() => {
            void runPrioritySmsReconciliation();
        }, PRIORITY_RECONCILIATION_INTERVAL_MS);

    /*
     * Structural cleanup remains conservative and runs separately.
     * Active priority sessions are explicitly excluded from this
     * lane, so cleanup cannot consume the priority batch.
     */
    setTimeout(() => {
        void runSmsReconciliation();
    }, 10_000);

    cleanupReconciliationTimer =
        setInterval(() => {
            void runSmsReconciliation();
        }, CLEANUP_RECONCILIATION_INTERVAL_MS);
}
