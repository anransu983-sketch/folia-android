import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
    pruneSpotubeMatchCache,
    readSpotubeMatchCache,
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
