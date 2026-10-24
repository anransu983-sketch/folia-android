import { describe, expect, it, vi } from 'vitest';
import type { UnifiedSong } from '@/types';

// test/unit/onlineMusic/spotubeMediaCache.test.ts
// 回归锁（核验报告 ② 的修正定案）：Spotube 借来的音频不许落进媒体缓存。
// 机制不是 spotubeSource 守卫，而是写入者 playedTrackCache 的分流：Spotify 声明了
// keepAudio/hasKeptAudio，keepsOwnSongAudio 为真，播完的歌走 provider 自留分支、
// 永不走 saveAudioBlob(媒体缓存键)。安卓上 provider 的 keep 又恒失败并被吞，
// 所以结果是：音频哪儿都不落。哪天有人摘掉 Spotify 的 keep 声明、或改了写入者
// 的分流，这条先红——那时才轮到给媒体缓存键加音源身份侧车。

const { data, saveAudioBlob, saveToCache } = vi.hoisted(() => {
    const store = new Map<string, unknown>();
    return {
        data: store,
        saveAudioBlob: vi.fn(async (key: string, blob: Blob) => { store.set(key, blob); }),
        saveToCache: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    };
});

vi.mock('@/services/audioCache', () => ({ notifyAudioCached: vi.fn(), saveAudioBlob }));
vi.mock('@/services/db', () => ({
    saveToCache,
    getFromCache: async () => null,
    getCacheEntriesByPrefix: async () => [],
    removeCacheEntries: async () => undefined,
}));
vi.mock('@/services/onlineMusic/resourceCache', () => ({
    hasCachedSongAudio: async (song: UnifiedSong) => data.has(`audio_online:spotify:${String(song.sourceRef.kind === 'online' ? song.sourceRef.mediaId : song.id)}`),
    hasCachedSongCover: async () => true,
    saveSongAudioLevel: async () => undefined,
}));
vi.mock('@/services/onlineMusic/songMetadata', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/onlineMusic/songMetadata')>();
    return {
        ...actual,
        getAudioSourceCacheLevel: (song: UnifiedSong, source: unknown) => actual.levelOfAudioSource(song, source as never),
    };
});
vi.mock('@/services/playbackRecovery/mediaCacheGuard', () => ({
    clearCachedSongAudioDistrust: vi.fn(),
    isCachedSongAudioDistrusted: () => false,
    isCacheableAudioResponse: () => true,
}));

import { cachePlayedTrackAssets } from '@/services/playedTrackCache';
import { keepsOwnSongAudio } from '@/services/onlineMusic/providerRegistry';
import { getSongResourceCacheKey } from '@/services/onlineMusic/resourceKeys';

const spotifySong: UnifiedSong = {
    id: 'track1',
    name: 'Blue Skies',
    artists: [{ id: 'a1', name: 'Ella Moss' }],
    album: { id: 'al1', name: 'Azure' },
    durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'track1' },
};

describe('spotube and the media cache', () => {
    it('names the media-cache audio key the writer would have used', () => {
        expect(getSongResourceCacheKey('audio', spotifySong)).toBe('audio_online:spotify:track1');
    });

    it('treats a Spotify song as provider-kept, which is what diverts the writer', () => {
        expect(keepsOwnSongAudio(spotifySong)).toBe(true);
    });

    it('leaves no media-cache audio entry after a Spotify song plays in full', async () => {
        const result = await cachePlayedTrackAssets(spotifySong, 'https://media.example/borrowed-stream');
        expect(result.audio).toBe(false);
        expect(saveAudioBlob).not.toHaveBeenCalled();
        expect(data.has('audio_online:spotify:track1')).toBe(false);
    });
});
