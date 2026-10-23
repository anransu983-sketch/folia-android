import { describe, expect, it } from 'vitest';
import { accountFromYtmAccountsList, ytmSignedInMarkOf } from '@/services/onlineMusic/ytm/ytmAccountsList';

// test/unit/onlineMusic/ytmAccountsList.test.ts
// The raw /account/accounts_list answer is the fallback witness of a YTM sign-in:
// its GFEEDBACK logged_in mark tells a taken sign-in from a guest answer, and the
// account menu inside its actions names who is signed in. Shapes mirror the ones
// the desktop reader (electron/ytm/webPages.cjs) was measured against.

const accountItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    accountItem: {
        accountName: { simpleText: 'An Ran' },
        channelHandle: { simpleText: '@anran' },
        accountPhoto: { thumbnails: [{ url: 'https://img.example/small' }, { url: 'https://img.example/large' }] },
        serviceEndpoint: {
            selectActiveIdentityEndpoint: {
                supportedTokens: [{ accountStateToken: { obfuscatedGaiaId: 'gaia-123' } }],
            },
        },
        ...overrides,
    },
});

const accountsListAnswer = (mark: string, items: Record<string, unknown>[]): unknown => ({
    responseContext: {
        serviceTrackingParams: [
            { service: 'CSI', params: [{ key: 'c', value: 'WEB_REMIX' }] },
            { service: 'GFEEDBACK', params: [{ key: 'logged_in', value: mark }] },
        ],
    },
    actions: [
        {
            getMultiPageMenuAction: {
                menu: {
                    multiPageMenuRenderer: {
                        sections: [
                            {
                                accountSectionListRenderer: {
                                    contents: [
                                        { accountItemSectionRenderer: { contents: items } },
                                    ],
                                },
                            },
                        ],
                    },
                },
            },
        },
    ],
});

describe('ytmSignedInMarkOf', () => {
    it('reads the logged_in mark of a signed-in answer', () => {
        expect(ytmSignedInMarkOf(accountsListAnswer('1', [accountItem()]))).toBe('1');
    });

    it('reads the mark of a guest answer', () => {
        expect(ytmSignedInMarkOf(accountsListAnswer('0', []))).toBe('0');
    });

    it('has no mark to read in an answer without responseContext', () => {
        expect(ytmSignedInMarkOf({})).toBeUndefined();
        expect(ytmSignedInMarkOf(null)).toBeUndefined();
        expect(ytmSignedInMarkOf('nope')).toBeUndefined();
    });
});

describe('accountFromYtmAccountsList', () => {
    it('reads the selected account with name, photo and gaia id', () => {
        const answer = accountsListAnswer('1', [
            accountItem({ accountName: { simpleText: 'Someone Else' } }),
            accountItem({ isSelected: true }),
        ]);
        expect(accountFromYtmAccountsList(answer)).toEqual({
            id: 'gaia-123',
            nickname: 'An Ran',
            avatarUrl: 'https://img.example/large',
        });
    });

    it('joins a runs-shaped name and falls back to the handle as id', () => {
        const answer = accountsListAnswer('1', [
            accountItem({
                accountName: { runs: [{ text: 'An' }, { text: ' Ran' }] },
                serviceEndpoint: undefined,
            }),
        ]);
        expect(accountFromYtmAccountsList(answer)).toEqual({
            id: '@anran',
            nickname: 'An Ran',
            avatarUrl: 'https://img.example/large',
        });
    });

    it('names nobody in a guest answer', () => {
        expect(accountFromYtmAccountsList(accountsListAnswer('0', []))).toBeNull();
        expect(accountFromYtmAccountsList({})).toBeNull();
    });
});
