import { getValidZoomAccessToken } from './zoomTokenService.js';

const ZOOM_API_BASE_URL = 'https://api.zoom.us/v2';

export type GetSmsSessionsOptions = {
    pageSize?: number;
    nextPageToken?: string;
};

export async function getSmsSessions(
    installationId: string,
    options: GetSmsSessionsOptions = {}
): Promise<any> {
    const accessToken =
        await getValidZoomAccessToken(installationId);

    const url = new URL(
        `${ZOOM_API_BASE_URL}/phone/sms/sessions`
    );

    if (options.pageSize) {
        url.searchParams.set(
            'page_size',
            String(options.pageSize)
        );
    }

    if (options.nextPageToken) {
        url.searchParams.set(
            'next_page_token',
            options.nextPageToken
        );
    }

    const response = await fetch(
        url.toString(),
        {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json'
            }
        }
    );

    const responseBody = await response.json();

    if (!response.ok) {
        console.error('[ZOOM SMS SESSIONS FAILED]', {
            installationId,
            status: response.status,
            zoomCode:
                typeof responseBody === 'object' &&
                responseBody !== null
                    ? responseBody.code
                    : undefined
        });

        throw new Error(
            `Zoom SMS sessions request failed with status ${response.status}`
        );
    }

    return responseBody;
}

export async function syncSmsSession(
    installationId: string,
    zoomSessionId: string,
    options: {
        syncType?: 'FSync' | 'ISync' | 'BSync';
        count?: number;
        syncToken?: string;
    } = {}
): Promise<any> {
    const accessToken =
        await getValidZoomAccessToken(installationId);

    const url = new URL(
        `${ZOOM_API_BASE_URL}/phone/sms/sessions/${encodeURIComponent(
            zoomSessionId
        )}/sync`
    );

    url.searchParams.set(
        'sync_type',
        options.syncType ?? 'FSync'
    );

    url.searchParams.set(
        'count',
        String(options.count ?? 100)
    );

    if (options.syncToken) {
        url.searchParams.set(
            'sync_token',
            options.syncToken
        );
    }

    const response = await fetch(
        url.toString(),
        {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json'
            }
        }
    );

    const responseBody = await response.json();

    if (!response.ok) {
        console.error('[ZOOM SMS SESSION SYNC FAILED]', {
            installationId,
            status: response.status,
            zoomCode:
                typeof responseBody === 'object' &&
                responseBody !== null
                    ? responseBody.code
                    : undefined,
            zoomMessage:
                typeof responseBody === 'object' &&
                responseBody !== null
                    ? responseBody.message
                    : undefined
        });

        const error = new Error(
            `Zoom SMS session sync failed with status ${response.status}`
        ) as Error & {
            zoomCode?: number;
            zoomStatus?: number;
        };

        error.zoomCode =
            typeof responseBody === 'object' &&
            responseBody !== null &&
            typeof responseBody.code === 'number'
                ? responseBody.code
                : undefined;

        error.zoomStatus = response.status;

        throw error;
    }

    return responseBody;
}

export async function sendSmsMessage(
    installationId: string,
    options: {
        fromPhoneNumber: string;
        toPhoneNumber: string;
        message: string;
        senderUserId?: string;
    }
): Promise<any> {
    const accessToken =
        await getValidZoomAccessToken(installationId);

    const message = options.message.trim();

    if (!message) {
        throw new Error('SMS message cannot be empty');
    }

    if (
        !options.fromPhoneNumber ||
        !options.toPhoneNumber
    ) {
        throw new Error(
            'SMS sender and recipient are required'
        );
    }

    const response = await fetch(
        `${ZOOM_API_BASE_URL}/phone/sms/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                to_members: [
                    {
                        phone_number:
                            options.toPhoneNumber
                    }
                ],
                message,
                sender: {
                    user_id:
                        options.senderUserId ?? 'me',
                    phone_number:
                        options.fromPhoneNumber
                }
            })
        }
    );

    const responseBody =
        await response.json().catch(() => null);

    if (!response.ok) {
        console.error('[ZOOM SMS SEND FAILED]', {
            installationId,
            status: response.status,
            zoomCode:
                typeof responseBody === 'object' &&
                responseBody !== null
                    ? responseBody.code
                    : undefined
        });

        const error = new Error(
            `Zoom SMS send failed with status ${response.status}`
        ) as Error & {
            zoomCode?: number;
            zoomStatus?: number;
        };

        error.zoomCode =
            typeof responseBody === 'object' &&
            responseBody !== null &&
            typeof responseBody.code === 'number'
                ? responseBody.code
                : undefined;

        error.zoomStatus = response.status;

        throw error;
    }

    console.log('[ZOOM SMS SEND SUCCESS]', {
        installationId,
        hasMessageId: Boolean(
            responseBody?.message_id
        )
    });

    return responseBody;
}

export async function getZoomPhoneUsers(
    installationId: string,
    options: {
        pageSize?: number;
        nextPageToken?: string;
    } = {}
): Promise<any> {
    const accessToken =
        await getValidZoomAccessToken(installationId);

    const url = new URL(
        `${ZOOM_API_BASE_URL}/phone/users`
    );

    url.searchParams.set(
        'page_size',
        String(options.pageSize ?? 100)
    );

    if (options.nextPageToken) {
        url.searchParams.set(
            'next_page_token',
            options.nextPageToken
        );
    }

    const response = await fetch(
        url.toString(),
        {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json'
            }
        }
    );

    const responseBody =
        await response.json().catch(() => null);

    if (!response.ok) {
        console.error('[ZOOM PHONE USERS FAILED]', {
            installationId,
            status: response.status,
            zoomCode:
                typeof responseBody === 'object' &&
                responseBody !== null
                    ? responseBody.code
                    : undefined,
            zoomMessage:
                typeof responseBody === 'object' &&
                responseBody !== null &&
                typeof responseBody.message === 'string'
                    ? responseBody.message
                    : undefined
        });

        const error = new Error(
            `Zoom Phone users request failed with status ${response.status}`
        ) as Error & {
            zoomCode?: number;
            zoomStatus?: number;
        };

        error.zoomCode =
            typeof responseBody === 'object' &&
            responseBody !== null &&
            typeof responseBody.code === 'number'
                ? responseBody.code
                : undefined;

        error.zoomStatus = response.status;

        throw error;
    }

    return responseBody;
}