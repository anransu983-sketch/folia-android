import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/spotify/spotifyNativeClientId.test.ts
// 自带 client_id 的传递：设置里填了，signIn / refresh 都要把它带给原生（原生用它替换内置
// 共用客户端去拼授权地址与换 token）；没填就传 undefined，原生回落内置的那个。

const plugin = vi.hoisted(() => ({
    signIn: vi.fn(),
    refresh: vi.fn(),
    status: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: () => true,
    },
    registerPlugin: () => plugin,
}));

import {
    refreshSpotifyNativeSession,
    requestSpotifyNativeSignIn,
} from '@/services/onlineMusic/spotify/spotifyNative';
import { useSpotifySettingsStore } from '@/stores/useSpotifySettingsStore';

const okSession = {
    ok: true,
    session: { accessToken: 'at', refreshToken: 'rt', expiresInMs: 3_600_000 },
};

describe('spotify native client id passthrough', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const storage = {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        useSpotifySettingsStore.setState({ spotifyClientId: '' });
        plugin.signIn.mockResolvedValue(okSession);
        plugin.refresh.mockResolvedValue(okSession);
    });

    afterEach(() => {
        useSpotifySettingsStore.setState({ spotifyClientId: '' });
        vi.unstubAllGlobals();
    });

    it('passes no client id while the setting is empty', async () => {
        await requestSpotifyNativeSignIn();
        expect(plugin.signIn).toHaveBeenCalledWith({ clientId: undefined });
        await refreshSpotifyNativeSession('rt-1');
        expect(plugin.refresh).toHaveBeenCalledWith({ refreshToken: 'rt-1', clientId: undefined });
    });

    it('passes the user client id to both sign-in and refresh once set', async () => {
        useSpotifySettingsStore.setState({ spotifyClientId: 'user-client-id' });
        await requestSpotifyNativeSignIn();
        expect(plugin.signIn).toHaveBeenCalledWith({ clientId: 'user-client-id' });
        await refreshSpotifyNativeSession('rt-1');
        expect(plugin.refresh).toHaveBeenCalledWith({ refreshToken: 'rt-1', clientId: 'user-client-id' });
    });
});
