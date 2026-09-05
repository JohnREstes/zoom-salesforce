import { db } from './db.js';
import { getZoomPhoneUsers } from './zoomPhoneService.js';

type ZoomPhoneNumber = {
    id?: string;
    number?: string;
};

type ZoomCallingPlan = {
    type?: string;
    name?: string;
    billing_subscription_id?: string;
};

type ZoomPhoneUser = {
    id?: string;
    phone_user_id?: string;
    email?: string;
    status?: string;
    calling_plans?: ZoomCallingPlan[];
    phone_numbers?: ZoomPhoneNumber[];
};

type ZoomPhoneUsersResponse = {
    next_page_token?: string;
    page_size?: number;
    total_records?: number;
    users?: ZoomPhoneUser[];
};

export async function syncCommunik8UsersFromZoom(
    installationId: string
): Promise<{
    usersProcessed: number;
    usersInsertedOrUpdated: number;
    singleNumberUsers: number;
    ambiguousNumberUsers: number;
    usersWithoutNumbers: number;
}> {
    let nextPageToken: string | undefined;

    let usersProcessed = 0;
    let usersInsertedOrUpdated = 0;
    let singleNumberUsers = 0;
    let ambiguousNumberUsers = 0;
    let usersWithoutNumbers = 0;

    do {
        const response =
            await getZoomPhoneUsers(
                installationId,
                {
                    pageSize: 100,
                    nextPageToken
                }
            ) as ZoomPhoneUsersResponse;

        const users =
            Array.isArray(response?.users)
                ? response.users
                : [];

        for (const zoomUser of users) {
            usersProcessed++;

            const zoomUserId =
                typeof zoomUser.id === 'string'
                    ? zoomUser.id.trim()
                    : '';

            const zoomEmail =
                typeof zoomUser.email === 'string'
                    ? zoomUser.email.trim().toLowerCase()
                    : '';

            if (!zoomUserId || !zoomEmail) {
                continue;
            }

            const phoneNumbers =
                Array.isArray(zoomUser.phone_numbers)
                    ? zoomUser.phone_numbers.filter(
                        phone =>
                            typeof phone?.number === 'string' &&
                            phone.number.trim().length > 0
                    )
                    : [];

            const phoneNumberCount =
                phoneNumbers.length;

            let zoomPhoneNumber: string | null = null;

            if (phoneNumberCount === 0) {
                usersWithoutNumbers++;
            } else if (phoneNumberCount === 1) {
                zoomPhoneNumber =
                    phoneNumbers[0].number!.trim();

                singleNumberUsers++;
            } else {
                ambiguousNumberUsers++;
            }

            const isActive =
                String(zoomUser.status ?? '')
                    .toLowerCase() === 'active';

            /*
             * For now, Communik8 only automatically selects a
             * sender when the Zoom user is active and has
             * exactly one assigned phone number.
             *
             * Multi-number users are intentionally left
             * unresolved rather than guessing.
             */
            const isSmsCapable =
                isActive &&
                phoneNumberCount === 1;

            await db.query(
                `
                INSERT INTO communic8_users (
                    installation_id,
                    zoom_user_id,
                    zoom_email,
                    zoom_phone_number,
                    zoom_phone_number_count,
                    is_sms_capable,
                    is_active,
                    matched_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    NULL,
                    NOW(),
                    NOW()
                )
                ON CONFLICT (
                    installation_id,
                    zoom_user_id
                )
                DO UPDATE SET
                    zoom_email = EXCLUDED.zoom_email,
                    zoom_phone_number =
                        EXCLUDED.zoom_phone_number,
                    zoom_phone_number_count =
                        EXCLUDED.zoom_phone_number_count,
                    is_sms_capable =
                        EXCLUDED.is_sms_capable,
                    is_active =
                        EXCLUDED.is_active,
                    updated_at = NOW()
                `,
                [
                    installationId,
                    zoomUserId,
                    zoomEmail,
                    zoomPhoneNumber,
                    phoneNumberCount,
                    isSmsCapable,
                    isActive
                ]
            );

            usersInsertedOrUpdated++;
        }

        nextPageToken =
            typeof response?.next_page_token === 'string' &&
            response.next_page_token.trim().length > 0
                ? response.next_page_token
                : undefined;

    } while (nextPageToken);

    console.log('[COMMUNIK8 ZOOM USER SYNC SUCCESS]', {
        installationId,
        usersProcessed,
        usersInsertedOrUpdated,
        singleNumberUsers,
        ambiguousNumberUsers,
        usersWithoutNumbers
    });

    return {
        usersProcessed,
        usersInsertedOrUpdated,
        singleNumberUsers,
        ambiguousNumberUsers,
        usersWithoutNumbers
    };
}