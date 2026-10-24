import { getCacheEntriesByPrefix, getFromCache, removeCacheEntries, saveToCache } from '../../db';
import { SPOTUBE_MATCHER_VERSION } from './spotubeMatch';
import type { SpotubeMatch } from './spotubeMatch';

// src/services/onlineMusic/spotify/spotubeSource.ts
// Spotube 的源编排：Spotify 的歌在别家目录里找到同一段录音、再拿它的音频来播。这一半先是
// 匹配缓存（规则在 spotubeMatch.ts）：匹配要搜两次、打分一遍，每首歌只该付一次这个代价；
// 负结果也缓存，但只留一天——目录和目录的对应关系会变，猜错一次不该判一首歌死刑。
// 搜索与取流的编排在文件后半（resolveSpotubeAudioSource）。

/** 正匹配的寿命：录音对应关系很稳，一个月内不重复匹配。 */
const SPOTUBE_POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 负匹配的寿命：一天。 */
const SPOTUBE_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** 匹配缓存的条数上限，超了删最旧的。 */
const SPOTUBE_MAX_MATCH_ENTRIES = 2000;
const SPOTUBE_MATCH_KEY_PREFIX = 'spotube:match:';

interface StoredSpotubeMatch {
    videoId?: string;
    score: number;
    matcherVersion: number;
    at: number;
    negative?: boolean;
    reason?: Extract<SpotubeMatch, { ok: false }>['reason'];
    durationDeltaMs?: number;
    queryShape?: 'title-artist' | 'title-album';
}

export interface CachedSpotubeHit {
    match: SpotubeMatch;
    /** 负命中时最佳候选的时长差（毫秒），未知为 null——只为把当时的死法如实写进日志。 */
    bestDurationDeltaMs: number | null;
}

/** 缓存键：有 ISRC 按录音走（同一录音的各版本共用一条），没有才退到这首 Spotify 歌本身。 */
export const spotubeMatchCacheKey = (owner: { isrc?: string; trackId: string }): string => (
    owner.isrc ? `${SPOTUBE_MATCH_KEY_PREFIX}isrc:${owner.isrc}` : `${SPOTUBE_MATCH_KEY_PREFIX}track:${owner.trackId}`
);

/**
 * 读一条缓存。匹配器版本对不上、或过了寿命的，都算没命中（条目留在原地，修剪时统一清）。
 */
export const readSpotubeMatchCache = async (key: string): Promise<CachedSpotubeHit | null> => {
    const entry = await getFromCache<StoredSpotubeMatch>(key);
    if (!entry || entry.matcherVersion !== SPOTUBE_MATCHER_VERSION) return null;
    const age = Date.now() - entry.at;
    if (entry.negative) {
        if (age > SPOTUBE_NEGATIVE_TTL_MS) return null;
        return {
            match: { ok: false, reason: entry.reason ?? 'below-threshold', bestScore: entry.score, queriesRun: 0, cached: true },
            bestDurationDeltaMs: entry.durationDeltaMs ?? null,
        };
    }
    if (!entry.videoId || age > SPOTUBE_POSITIVE_TTL_MS) return null;
    return {
        match: {
            ok: true,
            videoId: entry.videoId,
            score: entry.score,
            durationDeltaMs: entry.durationDeltaMs ?? -1,
            queryShape: entry.queryShape ?? 'title-artist',
            cached: true,
        },
        bestDurationDeltaMs: null,
    };
};

/**
 * 写一条缓存。负结果要把最佳候选的时长差一起存下（match 本身不带这个数），
 * 免得负命中时日志只能含糊其辞。
 */
export const writeSpotubeMatchCache = async (key: string, match: SpotubeMatch, bestDurationDeltaMs: number | null = null): Promise<void> => {
    if (match.ok) {
        await saveToCache(key, {
            videoId: match.videoId,
            score: match.score,
            matcherVersion: SPOTUBE_MATCHER_VERSION,
            at: Date.now(),
            durationDeltaMs: match.durationDeltaMs,
            queryShape: match.queryShape,
        } satisfies StoredSpotubeMatch);
        return;
    }
    await saveToCache(key, {
        score: match.bestScore,
        matcherVersion: SPOTUBE_MATCHER_VERSION,
        at: Date.now(),
        negative: true,
        reason: match.reason,
        ...(bestDurationDeltaMs !== null ? { durationDeltaMs: bestDurationDeltaMs } : {}),
    } satisfies StoredSpotubeMatch);
};

/** 修剪：条数超上限时按存入时间删最旧的，删到线内。条目的 timestamp 就是存入时间。 */
export const pruneSpotubeMatchCache = async (): Promise<void> => {
    const entries = await getCacheEntriesByPrefix(SPOTUBE_MATCH_KEY_PREFIX);
    if (entries.length <= SPOTUBE_MAX_MATCH_ENTRIES) return;
    const oldestFirst = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    await removeCacheEntries(oldestFirst.slice(0, entries.length - SPOTUBE_MAX_MATCH_ENTRIES).map(entry => entry.key));
};

let spotubePruneStarted = false;

/**
 * 修剪的挂点：本模块第一次真要做一首新匹配时懒触发一次（见 resolveSpotubeAudioSource）。
 * 不挂模块加载、也不挂 provider 注册——那些时刻 db 未必就绪，还会让每个导入本文件的
 * 测试都背上一次缓存扫描。匹配入口是唯一保证「真用上了、且 db 已可用」的点。
 */
export const pruneSpotubeMatchCacheOnce = (): void => {
    if (spotubePruneStarted) return;
    spotubePruneStarted = true;
    void pruneSpotubeMatchCache().catch(() => undefined);
};
