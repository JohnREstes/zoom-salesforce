import { db } from './db.js';
import { sendSmsMessage } from './zoomPhoneService.js';

type SmsSessionRow = {
    id: number;
    zoom_session_id: string;
};

type SmsParticipantRow = {
    owner_type: string | null;
    owner_id: string | null;
    is_session_owner: boolean;
    phone_number: string | null;
};

export async function sendSmsForSalesforceContact(
    installationId: string,
    contactId: string,
    message: string
): Promise<{
    smsSessionId: number;
    zoomSessionId: string;
    zoomMessageId: string | null;
}> {
    const cleanMessage = message.trim();

    if (!cleanMessage) {
        throw new Error('SMS message cannot be empty');
    }

    /*
     * For v1, reply through the Contact's most recently
     * active matched SMS conversation.
     */
    const sessionResult = await db.query<SmsSessionRow>(
        `
        SELECT
            id,
            zoom_session_id
        FROM zoom_sms_sessions
        WHERE installation_id = $1
          AND salesforce_contact_id = $2
        ORDER BY
            last_access_time DESC NULLS LAST,
            id DESC
        LIMIT 1
        `,
        [
            installationId,
            contactId
        ]
    );

    if (sessionResult.rowCount !== 1) {
        throw new Error(
            'No matched SMS conversation found for Contact'
        );
    }

    const session = sessionResult.rows[0];

    /*
     * Get Zoom's participant snapshot for this session.
     * Salesforce is never allowed to specify these numbers.
     */
    const participantResult =
        await db.query<SmsParticipantRow>(
            `
            SELECT
                owner_type,
                owner_id,
                is_session_owner,
                phone_number
            FROM zoom_sms_participants
            WHERE sms_session_id = $1
            `,
            [session.id]
        );

    const participants = participantResult.rows;

    const owners = participants.filter(
        participant =>
            participant.is_session_owner === true &&
            Boolean(participant.phone_number)
    );

    const externalParticipants = participants.filter(
        participant =>
            participant.is_session_owner !== true &&
            Boolean(participant.phone_number)
    );

    /*
     * Don't guess which number to use.
     * This first Salesforce implementation supports a
     * standard one-to-one SMS conversation.
     */
    if (owners.length !== 1) {
        throw new Error(
            'SMS conversation does not have exactly one sender'
        );
    }

    if (externalParticipants.length !== 1) {
        throw new Error(
            'SMS conversation is not a one-to-one conversation'
        );
    }

    const owner = owners[0];
    const externalParticipant =
        externalParticipants[0];

    const fromPhoneNumber = owner.phone_number;
    const toPhoneNumber =
        externalParticipant.phone_number;

    if (!fromPhoneNumber || !toPhoneNumber) {
        throw new Error(
            'SMS conversation is missing participant phone information'
        );
    }

    const zoomResponse = await sendSmsMessage(
        installationId,
        {
            fromPhoneNumber,
            toPhoneNumber,
            message: cleanMessage,
            senderUserId:
                owner.owner_id ?? undefined
        }
    );

    console.log('[SALESFORCE SMS SEND SUCCESS]', {
        installationId,
        contactId,
        smsSessionId: session.id,
        hasZoomMessageId: Boolean(
            zoomResponse?.message_id
        )
    });

    return {
        smsSessionId: session.id,
        zoomSessionId: session.zoom_session_id,
        zoomMessageId:
            typeof zoomResponse?.message_id === 'string'
                ? zoomResponse.message_id
                : null
    };
}