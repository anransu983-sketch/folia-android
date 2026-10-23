import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/ytmInPageLoginCheck.test.ts
// The sign-in check on Android: youtubei.js's account.getInfo() throws a bare
// 'Page contents not found' against the platform's current answers (seen on a
// real device, every time), so the check must fall back to the raw accounts_list
// answer and its logged_in mark — confirmed when the mark says signed in,
// expired when it says guest, and the original error when it says neither.

const mocks = vi.hoisted(() => ({
    signIn: vi.fn(),
    innertubeCreate: vi.fn(),
}));

vi.mock('@/services/onlineMusic/ytm/ytmNative', () => ({
    requestYtmNativeSignIn: mocks.signIn,
}));

vi.mock('youtubei.js/web', () => ({
    Innertube: { create: mocks.innertubeCreate },
}));

const signedInAnswer = {
    responseContext: {
        serviceTrackingParams: [
            { service: 'GFEEDBACK', params: [{ key: 'logged_in', value: '1' }] },
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
                                        {
                                            accountItemSectionRenderer: {
                                                contents: [
                                                    {
                                                        accountItem: {
                                                            isSelected: true,
                                                            accountName: { simpleText: 'An Ran' },
                                                            channelHandle: { simpleText: '@anran' },
                                                        },
                                                    },
                                                ],
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                },
            },
        },
    ],
};

const guestAnswer = {
    responseContext: {
        serviceTrackingParams: [
            { service: 'GFEEDBACK', params: [{ key: 'logged_in', value: '0' }] },
        ],
    },
};

const marklessAnswer = { responseContext: { serviceTrackingParams: [] } };

const loadRuntime = async () => {
    vi.resetModules();
    return import('@/services/onlineMusic/ytm/ytmInPageRuntime');
};

describe('ytm in-page sign-in check', () => {
    const yt = {
        account: { getInfo: vi.fn() },
        actions: { execute: vi.fn() },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.signIn.mockResolvedValue({ ok: true, session: { cookie: 'SAPISID=secret', userAgent: 'UA' } });
        mocks.innertubeCreate.mockResolvedValue(yt);
    });

    it('confirms the sign-in from the accounts list when getInfo throws Page contents not found', async () => {
        yt.account.getInfo.mockRejectedValue(new Error('Page contents not found'));
        yt.actions.execute.mockResolvedValue({ data: signedInAnswer });
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        const answer = await runtime.runYtmInPage('web_login_check');
        expect(answer).toEqual({
            state: 'confirmed',
            account: { id: '@anran', nickname: 'An Ran', avatarUrl: undefined },
        });
        expect(yt.actions.execute).toHaveBeenCalledWith('/account/accounts_list', { client: 'YTMUSIC', parse: false });
    });

    it('reports expired when the accounts list answers as a guest', async () => {
        yt.account.getInfo.mockRejectedValue(new Error('Page contents not found'));
        yt.actions.execute.mockResolvedValue({ data: guestAnswer });
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        await expect(runtime.runYtmInPage('web_login_check')).resolves.toEqual({ state: 'expired' });
    });

    it('surfaces the original getInfo error when the accounts list carries no mark either', async () => {
        yt.account.getInfo.mockRejectedValue(new Error('Page contents not found'));
        yt.actions.execute.mockResolvedValue({ data: marklessAnswer });
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        await expect(runtime.runYtmInPage('web_login_check')).rejects.toThrow('Page contents not found');
    });

    it('takes the getInfo answer directly when it names the account', async () => {
        yt.account.getInfo.mockResolvedValue({ account_name: 'Direct Name', channel_id: 'chan-1' });
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        const answer = await runtime.runYtmInPage('web_login_check');
        expect(answer).toEqual({
            state: 'confirmed',
            account: { id: 'chan-1', nickname: 'Direct Name', avatarUrl: undefined },
        });
        expect(yt.actions.execute).not.toHaveBeenCalled();
    });
});
