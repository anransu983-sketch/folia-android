import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult, UnifiedSong } from '@/types';
import { OnlineProviderError } from '@/types/onlineMusic';
import type { SpotubeMatch } from '@/services/onlineMusic/spotify/spotubeMatch';

// test/unit/onlineMusic/spotubeSource.test.ts
// Spotube 的匹配缓存：命中、过期、版本失效与修剪。db 用内存替身（照 db.test 的样子），
// 时间靠假时钟拨，条目的 timestamp 由替身在写入时盖。

const DAY = 24 * 60 * 60 * 1000;

const store = new Map<string, { data: unknown; timestamp: number }>();
vi.mock('@/services/db', () => ({
    saveToCache: async (key: string, data: unknown) => { store.set(key, { data, timestamp: Date.now() }); },
    getFromCache: async (key: string) => store.get(key)?.data ?? null,
    getCacheEntriesByPrefix: async (prefix: string) => [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({ key, data: entry.data, timestamp: entry.timestamp })),
    removeCacheEntries: async (keys: string[]) => { for (const key of keys) store.delete(key); },
}));

const omniMock = vi.hoisted(() => ({
    searchProviderSongs: vi.fn(),
    getAudioSource: vi.fn(),
}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: omniMock }));

import {
    isSpotubeNoMatchCause,
    pruneSpotubeMatchCache,
    readSpotubeMatchCache,
    resolveSpotubeAudioSource,
    spotubeMatchCacheKey,
    writeSpotubeMatchCache,
} from '@/services/onlineMusic/spotify/spotubeSource';

const matched: SpotubeMatch = { ok: true, videoId: 'video123', score: 95, durationDeltaMs: 400, queryShape: 'title-artist', cached: false };
const unmatched: SpotubeMatch = { ok: false, reason: 'duration-gate', bestScore: 75, queriesRun: 2, cached: false };

beforeEach(() => {
    store.clear();
    vi.useRealTimers();
});

describe('spotube match cache keys', () => {
    it('keys by isrc when the song has one, else by track id', () => {
        expect(spotubeMatchCacheKey({ isrc: 'USRC10000001', trackId: 'track1' })).toBe('spotube:match:isrc:USRC10000001');
        expect(spotubeMatchCacheKey({ trackId: 'track1' })).toBe('spotube:match:track:track1');
    });
});

describe('spotube match cache', () => {
    it('reads back a fresh positive match as a cache hit', async () => {
        const key = spotubeMatchCacheKey({ isrc: 'USRC1', trackId: 't1' });
        await writeSpotubeMatchCache(key, matched);
        const hit = await readSpotubeMatchCache(key);
        expect(hit?.match).toEqual({ ...matched, cached: true });
    });

    it('reads back a fresh negative match with its reason and best delta', async () => {
        const key = spotubeMatchCacheKey({ trackId: 't2' });
        await writeSpotubeMatchCache(key, unmatched, 4000);
        const hit = await readSpotubeMatchCache(key);
        expect(hit?.match).toEqual({ ok: false, reason: 'duration-gate', bestScore: 75, queriesRun: 0, cached: true });
        expect(hit?.bestDurationDeltaMs).toBe(4000);
    });

    it('treats a positive older than thirty days as a miss and a negative older than a day as a miss', async () => {
        vi.useFakeTimers();
        const posKey = spotubeMatchCacheKey({ trackId: 'old-pos' });
        const negKey = spotubeMatchCacheKey({ trackId: 'old-neg' });
        await writeSpotubeMatchCache(posKey, matched);
        await writeSpotubeMatchCache(negKey, unmatched, 4000);
        vi.setSystemTime(Date.now() + DAY + 1);
        expect(await readSpotubeMatchCache(negKey)).toBeNull();
        expect(await readSpotubeMatchCache(posKey)).not.toBeNull();
        vi.setSystemTime(Date.now() + 30 * DAY);
        expect(await readSpotubeMatchCache(posKey)).toBeNull();
    });

    it('treats an entry written by another matcher version as a miss', async () => {
        const key = spotubeMatchCacheKey({ trackId: 't3' });
        store.set(key, { data: { videoId: 'v', score: 90, matcherVersion: 999, at: Date.now() }, timestamp: Date.now() });
        expect(await readSpotubeMatchCache(key)).toBeNull();
    });

    it('misses on an empty cache', async () => {
        expect(await readSpotubeMatchCache(spotubeMatchCacheKey({ trackId: 'nope' }))).toBeNull();
    });
});

describe('spotube match cache pruning', () => {
    it('deletes the oldest entries down to the cap', async () => {
        vi.useFakeTimers();
        const base = Date.now();
        for (let i = 0; i < 2005; i += 1) {
            vi.setSystemTime(base + i * 1000);
            await writeSpotubeMatchCache(spotubeMatchCacheKey({ trackId: `t${i}` }), matched);
        }
        await pruneSpotubeMatchCache();
        const remaining = [...store.keys()];
        expect(remaining).toHaveLength(2000);
        expect(store.has(spotubeMatchCacheKey({ trackId: 't0' }))).toBe(false);
        expect(store.has(spotubeMatchCacheKey({ trackId: 't4' }))).toBe(false);
        expect(store.has(spotubeMatchCacheKey({ trackId: 't5' }))).toBe(true);
        expect(store.has(spotubeMatchCacheKey({ trackId: 't2004' }))).toBe(true);
    });

    it('leaves a cache at or under the cap alone', async () => {
        await writeSpotubeMatchCache(spotubeMatchCacheKey({ trackId: 'only' }), matched);
        await pruneSpotubeMatchCache();
        expect(store.size).toBe(1);
    });
});

// —— 源编排：搜索（带 session）、回退查询、日志、失败翻译 ——

const spotifySong = (over: Partial<UnifiedSong> = {}): UnifiedSong => ({
    id: 'track1',
    name: 'Blue Skies',
    artists: [{ id: 'a1', name: 'Ella Moss' }],
    album: { id: 'al1', name: 'Azure' },
    durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'track1' },
    ...over,
});

const found = (id: string, name: string, artist: string, album: string, durationMs: number): SongResult => ({
    id,
    name,
    artists: [{ id: `artist-${id}`, name: artist }],
    album: { id: `album-${id}`, name: album },
    durationMs,
    sourceRef: { kind: 'online', providerId: 'ytm', mediaId: id },
});
const exactFound = (id = 'v1', durationMs = 200_400) => found(id, 'Blue Skies', 'Ella Moss', 'Azure', durationMs);

const SOURCE = { url: 'https://media.example/audio', format: 'opus', quality: 'high' };

describe('resolveSpotubeAudioSource', () => {
    let logs: string[];
    beforeEach(() => {
        store.clear();
        vi.useRealTimers();
        logs = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
        omniMock.searchProviderSongs.mockReset();
        omniMock.getAudioSource.mockReset();
        omniMock.getAudioSource.mockResolvedValue(SOURCE);
    });

    it('matches cold, streams the matched recording, and serves the second play from cache', async () => {
        omniMock.searchProviderSongs.mockResolvedValue({ items: [exactFound()], hasMore: false, nextOffset: 1 });
        const song = spotifySong();
        await expect(resolveSpotubeAudioSource(song, 'high')).resolves.toBe(SOURCE);
        expect(omniMock.searchProviderSongs).toHaveBeenCalledTimes(1);
        expect(omniMock.searchProviderSongs).toHaveBeenCalledWith('ytm', 'Blue Skies Ella Moss', { limit: 20, offset: 0 }, { session: 'spotube' });
        const stub = omniMock.getAudioSource.mock.calls[0][0] as UnifiedSong;
        expect(stub.sourceRef).toEqual({ kind: 'online', providerId: 'ytm', mediaId: 'v1' });
        expect(omniMock.getAudioSource.mock.calls[0][1]).toBe('high');
        expect(logs).toContain('[Spotube] matched track1 -> v1 score=100 delta=0.4s query=title-artist cached=false');
        expect(store.has('spotube:match:track:track1')).toBe(true);

        await expect(resolveSpotubeAudioSource(song, 'high')).resolves.toBe(SOURCE);
        expect(omniMock.searchProviderSongs).toHaveBeenCalledTimes(1);
        expect(logs).toContain('[Spotube] cache hit track1 -> v1 (matcher v1)');
    });

    it('keys the cache by isrc when the song carries one', async () => {
        omniMock.searchProviderSongs.mockResolvedValue({ items: [exactFound()], hasMore: false, nextOffset: 1 });
        await resolveSpotubeAudioSource(spotifySong({ isrc: 'USRC10000001' }), 'high');
        expect(store.has('spotube:match:isrc:USRC10000001')).toBe(true);
    });

    it('runs the title+album fallback query when the first answer sits in the retry band', async () => {
        omniMock.searchProviderSongs
            .mockResolvedValueOnce({ items: [exactFound('slow', 204_000)], hasMore: false, nextOffset: 1 })
            .mockResolvedValueOnce({ items: [exactFound('v2')], hasMore: false, nextOffset: 1 });
        await expect(resolveSpotubeAudioSource(spotifySong(), 'high')).resolves.toBe(SOURCE);
        expect(omniMock.searchProviderSongs).toHaveBeenCalledTimes(2);
        expect(omniMock.searchProviderSongs).toHaveBeenNthCalledWith(2, 'ytm', 'Blue Skies Azure', { limit: 20, offset: 0 }, { session: 'spotube' });
        expect(logs).toContain('[Spotube] matched track1 -> v2 score=100 delta=0.4s query=title-album cached=false');
    });

    it('does not run the fallback query for a gate failure above the accept line', async () => {
        const cover = found('cover', 'Blue Skies', 'Cover Band', 'Azure', 200_000);
        omniMock.searchProviderSongs.mockResolvedValue({ items: [cover], hasMore: false, nextOffset: 1 });
        await expect(resolveSpotubeAudioSource(spotifySong(), 'high')).rejects.toMatchObject({ code: 'not-playable' });
        expect(omniMock.searchProviderSongs).toHaveBeenCalledTimes(1);
    });

    it('throws a marked spotify-owned no-match and caches it negatively for a day', async () => {
        const remix = found('remix', 'Blue Skies (Remix)', 'Ella Moss', 'Azure', 201_000);
        omniMock.searchProviderSongs
            .mockResolvedValueOnce({ items: [remix], hasMore: false, nextOffset: 1 })
            .mockResolvedValue({ items: [], hasMore: false, nextOffset: 0 });
        const song = spotifySong();
        const first = await resolveSpotubeAudioSource(song, 'high').catch((error: unknown) => error);
        expect(first).toBeInstanceOf(OnlineProviderError);
        const failure = first as OnlineProviderError;
        expect(failure.code).toBe('not-playable');
        expect(failure.providerId).toBe('spotify');
        expect(isSpotubeNoMatchCause(failure.cause)).toBe(true);
        expect(isSpotubeNoMatchCause(new Error('x'))).toBe(false);
        expect(logs).toContain('[Spotube] unmatched track1 "Blue Skies" reason=below-threshold best=74 delta=1.0s queries=2');

        const searches = omniMock.searchProviderSongs.mock.calls.length;
        await expect(resolveSpotubeAudioSource(song, 'high')).rejects.toMatchObject({ code: 'not-playable' });
        expect(omniMock.searchProviderSongs).toHaveBeenCalledTimes(searches);
        expect(logs).toContain('[Spotube] unmatched track1 "Blue Skies" reason=below-threshold best=74 delta=1.0s queries=0');
    });

    it('translates a bare anonymous-search failure into a spotify-owned network error, status carried', async () => {
        const bare = Object.assign(new Error('socket blew up'), { httpStatus: 503 });
        omniMock.searchProviderSongs.mockRejectedValue(bare);
        const failure = await resolveSpotubeAudioSource(spotifySong(), 'high').catch((error: unknown) => error) as OnlineProviderError;
        expect(failure).toBeInstanceOf(OnlineProviderError);
        expect(failure.code).toBe('network');
        expect(failure.providerId).toBe('spotify');
        expect(failure.httpStatus).toBe(503);
        expect(failure.cause).toBe(bare);
    });

    it('never lets a sign-in wall from the matched source escape as one: it becomes not-playable, owned by spotify', async () => {
        omniMock.searchProviderSongs.mockResolvedValue({ items: [exactFound()], hasMore: false, nextOffset: 1 });
        const wall = new OnlineProviderError('auth-required', 'sign in first', 'ytm');
        omniMock.getAudioSource.mockRejectedValue(wall);
        const failure = await resolveSpotubeAudioSource(spotifySong(), 'high').catch((error: unknown) => error) as OnlineProviderError;
        expect(failure.code).toBe('not-playable');
        expect(failure.providerId).toBe('spotify');
        expect(failure.cause).toBe(wall);
    });

    it('passes a null source through untouched', async () => {
        omniMock.searchProviderSongs.mockResolvedValue({ items: [exactFound()], hasMore: false, nextOffset: 1 });
        omniMock.getAudioSource.mockResolvedValue(null);
        await expect(resolveSpotubeAudioSource(spotifySong(), 'high')).resolves.toBeNull();
    });
});
