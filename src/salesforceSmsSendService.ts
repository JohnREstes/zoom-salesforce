import { db } from './db.js';
import { sendSmsMessage } from './zoomPhoneService.js';
import {
    getSalesforceContactById
} from './salesforceContactService.js';

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

type Communik8UserRow = {
    zoom_user_id: string | null;
    zoom_phone_number: string | null;
    zoom_phone_number_count: number;
    is_sms_capable: boolean;
    is_active: boolean;
};

function normalizeSmsPhoneNumber(
    phoneNumber: string
): string {
    const trimmed = phoneNumber.trim();

    // Already looks like E.164.
    if (/^\+[1-9]\d{7,14}$/.test(trimmed)) {
        return trimmed;
    }

    const digits = trimmed.replace(/\D/g, '');

    // North American 10-digit number.
    if (digits.length === 10) {
        return `+1${digits}`;
    }

    // North American number already containing country code.
    if (
        digits.length === 11 &&
        digits.startsWith('1')
    ) {
        return `+${digits}`;
    }

    throw new Error(
        'SMS phone number cannot be converted to E.164 format'
    );
}

export async function sendSmsForSalesforceContact(
    installationId: string,
    salesforceUserId: string,
    contactId: string,
    message: string
): Promise<{
    smsSessionId: number | null;
    zoomSessionId: string | null;
    zoomMessageId: string | null;
    firstContact: boolean;
}> {
    const cleanMessage = message.trim();

    if (!cleanMessage) {
        throw new Error('SMS message cannot be empty');
    }

    /*
     * First preference: preserve the existing proven behavior.
     * If this Contact already has a matched conversation,
     * reply through that conversation's Zoom participants.
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

    if (sessionResult.rowCount === 1) {
        const session = sessionResult.rows[0];

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

        const fromPhoneNumber =
            owner.phone_number;

        const toPhoneNumber =
            externalParticipant.phone_number;

        if (!fromPhoneNumber || !toPhoneNumber) {
            throw new Error(
                'SMS conversation is missing participant phone information'
            );
        }

        const zoomResponse =
            await sendSmsMessage(
                installationId,
                {
                    fromPhoneNumber,
                    toPhoneNumber,
                    message: cleanMessage,
                    senderUserId:
                        owner.owner_id ?? undefined
                }
            );

        console.log(
            '[SALESFORCE SMS SEND SUCCESS]',
            {
                installationId,
                contactId,
                smsSessionId: session.id,
                firstContact: false,
                hasZoomMessageId:
                    Boolean(zoomResponse?.message_id)
            }
        );

        return {
            smsSessionId: session.id,
            zoomSessionId:
                session.zoom_session_id,
            zoomMessageId:
                typeof zoomResponse?.message_id === 'string'
                    ? zoomResponse.message_id
                    : null,
            firstContact: false
        };
    }

    /*
     * No existing conversation.
     *
     * Resolve the Contact directly from Salesforce.
     */
    const contact =
        await getSalesforceContactById(
            installationId,
            contactId
        );

    if (!contact) {
        throw new Error(
            'Salesforce Contact not found'
        );
    }

    const rawToPhoneNumber =
        contact.mobilePhone?.trim() ||
        contact.phone?.trim() ||
        null;

    if (!rawToPhoneNumber) {
        throw new Error(
            'Salesforce Contact does not have an SMS phone number'
        );
    }

    const toPhoneNumber =
        normalizeSmsPhoneNumber(rawToPhoneNumber);

    /*
     * Resolve the current Salesforce user to their own
     * deterministic Zoom Phone sender identity.
     */
    const userResult =
        await db.query<Communik8UserRow>(
            `
            SELECT
                zoom_user_id,
                zoom_phone_number,
                zoom_phone_number_count,
                is_sms_capable,
                is_active
            FROM communic8_users
            WHERE installation_id = $1
              AND salesforce_user_id = $2
            LIMIT 1
            `,
            [
                installationId,
                salesforceUserId
            ]
        );

    if (userResult.rowCount !== 1) {
        throw new Error(
            'Salesforce user is not mapped to a Zoom Phone user'
        );
    }

    const sender = userResult.rows[0];

    if (
        !sender.is_active ||
        !sender.is_sms_capable ||
        sender.zoom_phone_number_count !== 1 ||
        !sender.zoom_user_id ||
        !sender.zoom_phone_number
    ) {
        throw new Error(
            'Salesforce user does not have a deterministic SMS sender'
        );
    }

    /*
     * Zoom's send-message endpoint can initiate a new SMS
     * conversation; an existing session ID is not required.
     */
    const zoomResponse =
        await sendSmsMessage(
            installationId,
            {
                fromPhoneNumber:
                    sender.zoom_phone_number,
                toPhoneNumber,
                message: cleanMessage,
                senderUserId:
                    sender.zoom_user_id
            }
        );

    const zoomSessionId =
        typeof zoomResponse?.session_id === 'string'
            ? zoomResponse.session_id
            : null;

    console.log(
        '[SALESFORCE SMS FIRST CONTACT SEND SUCCESS]',
        {
            installationId,
            contactId,
            hasZoomSessionId:
                Boolean(zoomSessionId),
            hasZoomMessageId:
                Boolean(zoomResponse?.message_id)
        }
    );

    /*
     * Do not invent a local session ID here.
     *
     * The Zoom webhook/reconciliation path can establish
     * the authoritative local session. Immediate local
     * persistence will be the next reliability change.
     */
    return {
        smsSessionId: null,
        zoomSessionId,
        zoomMessageId:
            typeof zoomResponse?.message_id === 'string'
                ? zoomResponse.message_id
                : null,
        firstContact: true
    };
}