import {
    fetchSalesforce
} from './salesforceApiService.js';

export type SalesforceContactMatch = {
    id: string;
    name: string | null;
    accountId: string | null;
    phone: string | null;
    mobilePhone: string | null;
    otherPhone: string | null;
    homePhone: string | null;
};

type SalesforceContactQueryResponse = {
    totalSize: number;
    done: boolean;
    records: Array<{
        Id: string;
        Name?: string | null;
        AccountId?: string | null;
        Phone?: string | null;
        MobilePhone?: string | null;
        OtherPhone?: string | null;
        HomePhone?: string | null;
    }>;
};

function normalizePhone(
    phoneNumber: string
): string {
    return phoneNumber.replace(/\D/g, '');
}

function getPhoneVariants(
    phoneNumber: string
): string[] {
    const normalized =
        normalizePhone(phoneNumber);

    const variants =
        new Set<string>();

    if (!normalized) {
        return [];
    }

    variants.add(normalized);

    /*
     * North American numbers commonly arrive from Zoom
     * in E.164 form with a leading country code.
     */
    if (
        normalized.length === 11 &&
        normalized.startsWith('1')
    ) {
        variants.add(
            normalized.substring(1)
        );
    }

    if (normalized.length === 10) {
        variants.add(
            `1${normalized}`
        );
    }

    return Array.from(variants);
}

function phoneMatches(
    candidate: string | null | undefined,
    variants: string[]
): boolean {
    if (!candidate) {
        return false;
    }

    const candidateVariants =
        getPhoneVariants(candidate);

    return candidateVariants.some(
        value => variants.includes(value)
    );
}

export async function findSalesforceContactsByPhone(
    installationId: string,
    phoneNumber: string
): Promise<SalesforceContactMatch[]> {
    const variants =
        getPhoneVariants(phoneNumber);

    if (variants.length === 0) {
        return [];
    }

    /*
     * SOSL is better suited than SOQL for this first lookup
     * because Salesforce phone fields may contain formatting.
     *
     * We search using the last 10 digits when available,
     * then verify exact normalized matches ourselves.
     */
    const normalized =
        normalizePhone(phoneNumber);

    const searchValue =
        normalized.length >= 10
            ? normalized.slice(-10)
            : normalized;

    const sosl =
        `FIND {${searchValue}} IN PHONE FIELDS ` +
        `RETURNING Contact(` +
        `Id, Name, AccountId, Phone, MobilePhone, ` +
        `OtherPhone, HomePhone LIMIT 20)`;

    const path =
        `/services/data/v65.0/search/?q=${encodeURIComponent(sosl)}`;

    const response =
        await fetchSalesforce(
            installationId,
            path
        );

    if (!response.ok) {
        console.error(
            '[SALESFORCE CONTACT PHONE SEARCH FAILED]',
            {
                installationId,
                status: response.status
            }
        );

        throw new Error(
            `Salesforce Contact phone search failed with status ${response.status}`
        );
    }

    const data =
        (await response.json()) as {
            searchRecords?: SalesforceContactQueryResponse['records'];
        };

    const records =
        Array.isArray(data.searchRecords)
            ? data.searchRecords
            : [];

    return records
        .filter(record =>
            phoneMatches(
                record.Phone,
                variants
            ) ||
            phoneMatches(
                record.MobilePhone,
                variants
            ) ||
            phoneMatches(
                record.OtherPhone,
                variants
            ) ||
            phoneMatches(
                record.HomePhone,
                variants
            )
        )
        .map(record => ({
            id: record.Id,
            name: record.Name ?? null,
            accountId:
                record.AccountId ?? null,
            phone:
                record.Phone ?? null,
            mobilePhone:
                record.MobilePhone ?? null,
            otherPhone:
                record.OtherPhone ?? null,
            homePhone:
                record.HomePhone ?? null
        }));
}