import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    readSpotifyClientId,
    useSpotifySettingsStore,
} from '@/stores/useSpotifySettingsStore';

// test/unit/stores/spotifySettingsStore.test.ts
// 自带 Spotify Client ID：默认空（= 内置共用客户端），存 spotify_client_id；写入去首尾
// 空白，清空等于删键 —— 读取端（spotifyNative）拿到空字符串就不会往原生传这个参数。

describe('spotify settings store', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        useSpotifySettingsStore.setState({ spotifyClientId: '' });
    });

    afterEach(() => {
        useSpotifySettingsStore.setState({ spotifyClientId: '' });
        vi.unstubAllGlobals();
    });

    it('defaults to empty when nothing is stored', async () => {
        vi.resetModules();
        const fresh = await import('@/stores/useSpotifySettingsStore');
        expect(fresh.useSpotifySettingsStore.getState().spotifyClientId).toBe('');
        expect(fresh.readSpotifyClientId()).toBe('');
    });

    it('restores the stored id on load', async () => {
        values.set('spotify_client_id', 'my-client-id');
        vi.resetModules();
        const fresh = await import('@/stores/useSpotifySettingsStore');
        expect(fresh.readSpotifyClientId()).toBe('my-client-id');
    });

    it('stores the id trimmed and clears back to no key', () => {
        useSpotifySettingsStore.getState().handleSetSpotifyClientId('  abc123  ');
        expect(values.get('spotify_client_id')).toBe('abc123');
        expect(readSpotifyClientId()).toBe('abc123');
        useSpotifySettingsStore.getState().handleSetSpotifyClientId('   ');
        expect(values.has('spotify_client_id')).toBe(false);
        expect(readSpotifyClientId()).toBe('');
    });
});
