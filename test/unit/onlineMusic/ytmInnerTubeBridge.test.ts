import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/ytmInnerTubeBridge.test.ts
// The Web side of the Android InnerTube bridge (ytmInnerTube.ts): the bridge's
// answers must come back in the provider's audio shape, and every failure code
// the bridge can report must land in the failure classification the UI already
// speaks (ytmFailure) — 429 as network + the agreed sentence, an all-clients
// sign-in wall as not-playable ending in (LOGIN_REQUIRED), and so on. The
// native side is a fixture here; the real client chain is device-verified.

const mocks = vi.hoisted(() => ({
    isPluginAvailable: vi.fn(),
    isAndroid: vi.fn(),
    resolveStream: vi.fn(),
    status: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isPluginAvailable: mocks.isPluginAvailable },
    registerPlugin: () => ({ resolveStream: mocks.resolveStream, status: mocks.status }),
}));

vi.mock('@/platform/runtime', () => ({
    isCapacitorAndroid: mocks.isAndroid,
}));

const loadBridge = async () => {
    vi.resetModules();
    return import('@/services/onlineMusic/ytm/ytmInnerTube');
};

const SESSION = { cookie: 'SAPISID=abc; SID=def', userAgent: 'Mozilla/5.0 (Linux; Android 16)' };
const STREAM_URL = 'https://rr1---sn-example.googlevideo.com/videoplayback?expire=1999999999&itag=251';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAndroid.mockReturnValue(true);
    mocks.isPluginAvailable.mockReturnValue(true);
    mocks.status.mockResolvedValue({ ready: true, visitorData: 'held', egress: 'ok (egress verified: HTTP 206, audio/webm)' });
    mocks.resolveStream.mockResolvedValue({
        ok: true, stream: { url: STREAM_URL, route: 'android_vr', itag: 251, bitrate: 128000, level: 'high' },
    });
});

describe('resolveYtmStreamViaBridge', () => {
    it('hands a successful answer back in the provider audio shape, session included', async () => {
        const bridge = await loadBridge();
        const stream = await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'high', session: SESSION });
        expect(stream).toEqual({ url: STREAM_URL, route: 'android_vr', itag: 251, bitrate: 128000, level: 'high' });
        expect(mocks.resolveStream).toHaveBeenCalledWith({
            videoId: 'dQw4w9WgXcQ', quality: 'high', allowSignedIn: true, session: SESSION,
        });
    });

    it('sends no session key at all when nobody is signed in', async () => {
        const bridge = await loadBridge();
        await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null });
        const call = mocks.resolveStream.mock.calls[0]?.[0];
        expect(call.allowSignedIn).toBe(false);
        expect('session' in call).toBe(false);
    });

    it('drops a level the provider does not speak instead of passing it through', async () => {
        mocks.resolveStream.mockResolvedValue({ ok: true, stream: { url: STREAM_URL, route: 'ios', level: 'lossless' } });
        const bridge = await loadBridge();
        const stream = await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'ultra', session: null });
        expect(stream.level).toBeUndefined();
        expect(stream.route).toBe('ios');
    });

    it('keeps the downgrade the bridge reports (asked ultra, served high)', async () => {
        mocks.resolveStream.mockResolvedValue({ ok: true, stream: { url: STREAM_URL, route: 'android_vr', itag: 251, level: 'high' } });
        const bridge = await loadBridge();
        const stream = await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'ultra', session: null });
        expect(stream.level).toBe('high');
    });

    it('is unsupported, not silent, when the plugin is not there', async () => {
        mocks.isPluginAvailable.mockReturnValue(false);
        const bridge = await loadBridge();
        await expect(bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null }))
            .rejects.toMatchObject({ code: 'unsupported' });
        expect(mocks.resolveStream).not.toHaveBeenCalled();
    });

    it('treats a success without an address as an unreadable answer', async () => {
        mocks.resolveStream.mockResolvedValue({ ok: true, stream: { route: 'android_vr' } });
        const bridge = await loadBridge();
        await expect(bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null }))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });

    it('rejects a flat answer instead of reading fields off the wrong level', async () => {
        // The contract (design §4.2) nests the stream under `stream` and the failure
        // under `error`; a flat answer is a different bridge and must not be read.
        mocks.resolveStream.mockResolvedValue({ ok: true, url: STREAM_URL, route: 'android_vr' });
        const bridge = await loadBridge();
        await expect(bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null }))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });

    it('treats a bridge that does not answer as unavailable', async () => {
        mocks.resolveStream.mockRejectedValue(new Error('plugin exploded'));
        const bridge = await loadBridge();
        await expect(bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null }))
            .rejects.toMatchObject({ code: 'unavailable' });
    });
});

describe('bridge failure mapping', () => {
    const cases: Array<[string, string, (message: string) => void]> = [
        ['rate-limited', 'network', (message) => {
            expect(message).toBe('YouTube Music asked to wait before trying again');
        }],
        ['login-required', 'not-playable', (message) => {
            expect(message.endsWith('(LOGIN_REQUIRED)')).toBe(true);
        }],
        ['region-restricted', 'region-restricted', (message) => {
            expect(message).toContain('not available in this region');
        }],
        ['not-playable', 'not-playable', (message) => {
            expect(message).toContain('android_vr: formats');
        }],
        ['egress-blocked', 'network', (message) => {
            expect(message).toContain('could not be fetched from this device');
        }],
        ['invalid-response', 'invalid-response', () => undefined],
        ['network', 'network', () => undefined],
        ['some-future-code', 'unavailable', () => undefined],
    ];

    it.each(cases)('maps bridge code %s to provider code %s', async (bridgeCode, providerCode, checkMessage) => {
        mocks.resolveStream.mockResolvedValue({
            ok: false,
            error: {
                code: bridgeCode,
                message: bridgeCode === 'region-restricted'
                    ? 'This video is not available in this region'
                    : bridgeCode === 'egress-blocked'
                        ? 'The stream address could not be fetched from this device'
                        : 'The bridge could not resolve this track',
                attempts: [{ client: 'android_vr', code: 'formats', detail: 'cipher-only' }],
            },
        });
        const bridge = await loadBridge();
        const failure = await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null })
            .catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: providerCode });
        checkMessage((failure as Error).message);
    });

    it('the login-required mapping is the one ytmFailure reads as sign-in-needed', async () => {
        mocks.resolveStream.mockResolvedValue({
            ok: false,
            error: { code: 'login-required', message: 'YouTube Music asked for a sign-in on every client tried', attempts: [] },
        });
        const bridge = await loadBridge();
        const { describeYtmFailure } = await import('@/services/onlineMusic/ytm/ytmFailure');
        const failure = await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null })
            .catch((error: unknown) => error);
        expect(describeYtmFailure('audio', failure)).toEqual({ case: 'sign-in-needed', code: 'LOGIN_REQUIRED' });
    });

    it('the rate-limited mapping is the one ytmFailure reads as retry-later', async () => {
        mocks.resolveStream.mockResolvedValue({ ok: false, error: { code: 'rate-limited', message: 'HTTP 429', attempts: [] } });
        const bridge = await loadBridge();
        const { describeYtmFailure } = await import('@/services/onlineMusic/ytm/ytmFailure');
        const failure = await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null })
            .catch((error: unknown) => error);
        expect(describeYtmFailure('audio', failure)).toEqual({ case: 'retry-later', httpStatus: 429 });
    });
});

describe('bridge diagnostics', () => {
    it('reports availability, visitor, egress and the last resolve; status is fetched once', async () => {
        const bridge = await loadBridge();
        await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null });
        await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null });
        const lines = bridge.getYtmInnerTubeDiagnostics();
        expect(lines[0]).toBe('innertube bridge: available');
        expect(lines).toContain('visitor data: held');
        expect(lines.some(line => line.startsWith('stream egress: ok'))).toBe(true);
        expect(lines.some(line => /^last resolve: ok via android_vr \(itag 251\), \d+ms$/.test(line))).toBe(true);
        expect(mocks.status).toHaveBeenCalledTimes(1);
    });

    it('records the failure trail of the last resolve', async () => {
        mocks.resolveStream.mockResolvedValue({
            ok: false,
            error: {
                code: 'not-playable', message: 'No client handed over a playable format',
                attempts: [{ client: 'android_vr', code: 'formats' }, { client: 'ios', code: 'formats' }],
            },
        });
        const bridge = await loadBridge();
        await bridge.resolveYtmStreamViaBridge({ videoId: 'dQw4w9WgXcQ', quality: 'standard', session: null }).catch(() => undefined);
        const lines = bridge.getYtmInnerTubeDiagnostics();
        expect(lines.some(line => /^last resolve: failed \(not-playable\), \d+ms — android_vr: formats; ios: formats$/.test(line))).toBe(true);
    });
});
