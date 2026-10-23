import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeFetch } from '@/services/nativeHttpFetch';

// test/unit/services/nativeHttpFetch.test.ts
// The native fetch must merge headers the way fetch does: what the init carries
// overrides what the Request was built with. A protocol client that builds a
// Request first and puts its credential headers in the init (Authorization,
// Cookie) lost them here once, and every signed-in request went out as a guest.

const mocks = vi.hoisted(() => ({
    httpRequest: vi.fn(),
}));

const stubNativeBridge = (): void => {
    vi.stubGlobal('window', {
        Capacitor: {
            isNativePlatform: () => true,
            getPlatform: () => 'android',
            isPluginAvailable: () => true,
            Plugins: { FoliaNative: { httpRequest: mocks.httpRequest } },
        },
    });
};

describe('createNativeFetch header merging', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubNativeBridge();
        mocks.httpRequest.mockResolvedValue({ status: 200, headers: [], bodyBase64: '' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the credential headers that only exist in the init when the input is a Request', async () => {
        const request = new Request('https://www.youtube.com/youtubei/v1/account/accounts_list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const nativeFetch = createNativeFetch();
        await nativeFetch(request, {
            body: '{}',
            headers: {
                Authorization: 'SAPISIDHASH 123_abc',
                Cookie: 'SAPISID=secret',
                'X-Goog-Authuser': '0',
            },
        });
        expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
        const sent = mocks.httpRequest.mock.calls[0][0];
        expect(sent.headers.authorization).toBe('SAPISIDHASH 123_abc');
        expect(sent.headers.cookie).toBe('SAPISID=secret');
        expect(sent.headers['x-goog-authuser']).toBe('0');
        expect(sent.headers['content-type']).toBe('application/json');
    });

    it('lets an init header override the same header on the Request', async () => {
        const request = new Request('https://example.com/', {
            headers: { 'X-Client': 'from-request' },
        });
        const nativeFetch = createNativeFetch();
        await nativeFetch(request, { headers: { 'X-Client': 'from-init' } });
        const sent = mocks.httpRequest.mock.calls[0][0];
        expect(sent.headers['x-client']).toBe('from-init');
    });

    it('passes string-input headers through untouched', async () => {
        const nativeFetch = createNativeFetch();
        await nativeFetch('https://example.com/', { headers: { Authorization: 'Bearer token' } });
        const sent = mocks.httpRequest.mock.calls[0][0];
        expect(sent.headers.authorization).toBe('Bearer token');
    });
});
