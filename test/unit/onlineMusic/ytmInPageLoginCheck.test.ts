import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/ytmInPageLoginCheck.test.ts
// The sign-in check on Android: youtubei.js's account.getInfo() throws a bare
// 'Page contents not found' against the platform's current answers (seen on a
// real device, every time), so the check falls back to two further witnesses —
// the raw accounts_list answer with its logged_in mark, and the music homepage
// fetched with the same cookie, which writes its own LOGGED_IN flag. Any one
// credible witness confirms the sign-in: on a real device the interface route
// answered "guest" to a cookie the user had provably signed in with (avatar on
// screen before the window closed), so accounts_list must not veto the
// homepage. Both saying guest means expired; neither saying anything surfaces
// the original getInfo error.

const mocks = vi.hoisted(() => ({
    signIn: vi.fn(),
    innertubeCreate: vi.fn(),
    fetch: vi.fn(),
}));

const homepageAnswer = (html: string) => ({
    ok: true,
    status: 200,
    text: async () => html,
});

const GUEST_HOMEPAGE = '<script>ytcfg.set({"LOGGED_IN":false});</script>';
const SIGNED_IN_HOMEPAGE = '<script>ytcfg.set({"LOGGED_IN":true});</script>';
const MARKLESS_HOMEPAGE = '<html><body>no flags here</body></html>';

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
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.fetch.mockResolvedValue(homepageAnswer(GUEST_HOMEPAGE));
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

    it('reports expired when the accounts list and the homepage both answer as a guest', async () => {
        yt.account.getInfo.mockRejectedValue(new Error('Page contents not found'));
        yt.actions.execute.mockResolvedValue({ data: guestAnswer });
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        await expect(runtime.runYtmInPage('web_login_check')).resolves.toEqual({ state: 'expired' });
    });

    it('confirms the sign-in from the homepage when the accounts list answers as a guest', async () => {
        yt.account.getInfo.mockRejectedValue(new Error('Page contents not found'));
        yt.actions.execute.mockResolvedValue({ data: guestAnswer });
        mocks.fetch.mockResolvedValue(homepageAnswer(SIGNED_IN_HOMEPAGE));
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        const answer = await runtime.runYtmInPage('web_login_check');
        expect(answer).toEqual({
            state: 'confirmed',
            account: { id: 'ytm', nickname: 'YouTube Music', avatarUrl: undefined },
        });
        // The homepage probe must have carried the handed-back cookie itself.
        const fetchCalls = mocks.fetch.mock.calls as unknown as Array<[unknown, { headers?: Record<string, string> } | undefined]>;
        const homepageCall = fetchCalls.find(([input]) => String(input) === 'https://music.youtube.com/');
        expect(homepageCall).toBeDefined();
        expect(new Headers(homepageCall?.[1]?.headers).get('cookie')).toBe('SAPISID=secret');
    });

    it('surfaces the original getInfo error when no witness can tell either', async () => {
        yt.account.getInfo.mockRejectedValue(new Error('Page contents not found'));
        yt.actions.execute.mockResolvedValue({ data: marklessAnswer });
        mocks.fetch.mockResolvedValue(homepageAnswer(MARKLESS_HOMEPAGE));
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        await expect(runtime.runYtmInPage('web_login_check')).rejects.toThrow('Page contents not found');
    });

    it('lists the handed-back cookie key names (never values) in the diagnostics', async () => {
        yt.account.getInfo.mockRejectedValue(new Error('Page contents not found'));
        yt.actions.execute.mockResolvedValue({ data: guestAnswer });
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        await runtime.runYtmInPage('web_login_check');
        const texts = runtime.getYtmLoginDiagnostics().map((line) => (line as unknown as { text: string }).text);
        expect(texts.some((text) => text.startsWith('cookie keys:') && text.includes('SAPISID'))).toBe(true);
        expect(texts.some((text) => text.includes('secret'))).toBe(false);
        expect(texts.some((text) => text.includes('accounts_list answered as a guest'))).toBe(true);
        expect(texts.some((text) => text.includes('homepage says guest'))).toBe(true);
    });

    it('adds the youtube.com Origin to innertube API calls and only to those', async () => {
        yt.account.getInfo.mockResolvedValue({ account_name: 'Direct Name', channel_id: 'chan-1' });
        const runtime = await loadRuntime();
        await runtime.signInYtmInPage();
        await runtime.runYtmInPage('web_login_check');
        const apiFetch = mocks.innertubeCreate.mock.calls[0]?.[0]?.fetch as typeof fetch;
        expect(apiFetch).toBeDefined();

        const seenInits: Array<RequestInit | undefined> = [];
        mocks.fetch.mockImplementation(async (_input: unknown, init?: RequestInit) => {
            seenInits.push(init);
            return homepageAnswer('');
        });
        await apiFetch(new Request('https://www.youtube.com/youtubei/v1/account/accounts_list?key=x'), {
            headers: new Headers({ authorization: 'SAPISIDHASH 1_abc' }),
        });
        expect(new Headers(seenInits[0]?.headers).get('origin')).toBe('https://www.youtube.com');
        expect(new Headers(seenInits[0]?.headers).get('authorization')).toBe('SAPISIDHASH 1_abc');

        await apiFetch('https://music.youtube.com/', {});
        expect(new Headers(seenInits[1]?.headers).get('origin')).toBeNull();
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
