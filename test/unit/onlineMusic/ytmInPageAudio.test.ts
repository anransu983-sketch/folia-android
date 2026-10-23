import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/ytmInPageAudio.test.ts
// The audio operation of the in-page runtime on Android: it must not go
// through youtubei.js (the WEB client's stream answer needs a poToken the
// WebView cannot mint) but through the native InnerTube bridge, and the
// bridge's answer must reach the provider in the desktop wire shape, with
// the raw googlevideo address swapped for the loopback proxy first. Bridge
// failures must propagate as the OnlineProviderError they already are —
// the runtime must not flatten them into something vaguer.

const mocks = vi.hoisted(() => ({
    signIn: vi.fn(),
    bridge: vi.fn(),
    proxy: vi.fn(),
    innertubeCreate: vi.fn(),
}));

vi.mock('@/services/onlineMusic/ytm/ytmNative', () => ({
    requestYtmNativeSignIn: mocks.signIn,
}));

vi.mock('@/services/onlineMusic/ytm/ytmInnerTube', () => ({
    resolveYtmStreamViaBridge: mocks.bridge,
    getYtmInnerTubeDiagnostics: () => [
        'innertube bridge: available',
        'last resolve: ok via android_vr (itag 251)',
    ],
}));

vi.mock('@/services/nativeRemoteAudio', () => ({
    proxyNativeRemoteAudioUrl: mocks.proxy,
}));

vi.mock('youtubei.js/web', () => ({
    Innertube: { create: mocks.innertubeCreate },
    Parser: { parseResponse: vi.fn() },
    YTNodes: {},
    Constants: { CLIENTS: { YTMUSIC: { NAME: 'WEB_REMIX', VERSION: '1.20260101.01.00' } } },
}));

const loadRuntime = async () => {
    vi.resetModules();
    return import('@/services/onlineMusic/ytm/ytmInPageRuntime');
};

const VIDEO_ID = 'dQw4w9WgXcQ';
const STREAM_URL = 'https://rr1---sn-example.googlevideo.com/videoplayback?expire=1999999999&itag=251';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.bridge.mockResolvedValue({
        url: STREAM_URL, route: 'android_vr', itag: 251, bitrate: 128000, level: 'high',
    });
    mocks.proxy.mockImplementation(async (url: string) => `proxied:${url}`);
});

describe('runYtmInPage audio', () => {
    it('answers in the wire shape with the loopback-proxied address', async () => {
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('audio', { id: VIDEO_ID, quality: 'high' });
        expect(answer).toEqual({
            url: `proxied:${STREAM_URL}`, route: 'android_vr', itag: 251, bitrate: 128000, level: 'high',
        });
        expect(mocks.proxy).toHaveBeenCalledWith(STREAM_URL);
    });

    it('asks the bridge for the song, signed out when nobody signed in', async () => {
        const runtime = await loadRuntime();
        await runtime.runYtmInPage('audio', { id: VIDEO_ID, quality: 'ultra' });
        expect(mocks.bridge).toHaveBeenCalledWith({ videoId: VIDEO_ID, quality: 'ultra', session: null });
    });

    it('defaults the quality to standard when none was asked for', async () => {
        const runtime = await loadRuntime();
        await runtime.runYtmInPage('audio', { id: VIDEO_ID });
        expect(mocks.bridge).toHaveBeenCalledWith({ videoId: VIDEO_ID, quality: 'standard', session: null });
    });

    it('rejects a malformed track id before the bridge is asked', async () => {
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('audio', { id: 'not a video id!!' }))
            .rejects.toMatchObject({ code: 'invalid-response' });
        expect(mocks.bridge).not.toHaveBeenCalled();
    });

    it('lets a bridge failure through with its own classification intact', async () => {
        const { OnlineProviderError } = await import('@/types/onlineMusic');
        mocks.bridge.mockRejectedValue(new OnlineProviderError('not-playable', 'YouTube Music asked for a sign-in (LOGIN_REQUIRED)', 'ytm'));
        const runtime = await loadRuntime();
        const failure = await runtime.runYtmInPage('audio', { id: VIDEO_ID, quality: 'standard' }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(OnlineProviderError);
        expect(failure).toMatchObject({ code: 'not-playable' });
        expect((failure as Error).message).toContain('LOGIN_REQUIRED');
    });

    it('keeps the old unsupported answer when the bridge is not there', async () => {
        const { OnlineProviderError } = await import('@/types/onlineMusic');
        mocks.bridge.mockRejectedValue(new OnlineProviderError('unsupported', 'YouTube Music audio is not available on Android yet', 'ytm'));
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('audio', { id: VIDEO_ID, quality: 'standard' }))
            .rejects.toMatchObject({ code: 'unsupported' });
    });

    it('no longer lists audio among the unsupported operations', async () => {
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('playlist_edit', { id: VIDEO_ID }))
            .rejects.toMatchObject({ code: 'unsupported' });
        await expect(runtime.runYtmInPage('audio', { id: VIDEO_ID, quality: 'standard' }))
            .resolves.toMatchObject({ route: 'android_vr' });
    });
});

describe('getYtmLoginDiagnostics', () => {
    it('carries the bridge lines so a playback failure report shows the bridge state', async () => {
        const runtime = await loadRuntime();
        const texts = runtime.getYtmLoginDiagnostics().map((line) => (line as unknown as { text: string }).text);
        expect(texts).toContain('innertube bridge: available');
        expect(texts).toContain('last resolve: ok via android_vr (itag 251)');
    });
});
