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
    zoomSessionId: string
): Promise<any> {
    const accessToken =
        await getValidZoomAccessToken(installationId);

    const url = new URL(
        `${ZOOM_API_BASE_URL}/phone/sms/sessions/${encodeURIComponent(
            zoomSessionId
        )}/sync`
    );

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
                    : undefined
        });

        throw new Error(
            `Zoom SMS session sync failed with status ${response.status}`
        );
    }

    return responseBody;
}