import type { SongResult, UnifiedSong } from '../../../types';
import type { AudioQualityPreference, OmniAudioSource } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { getCacheEntriesByPrefix, getFromCache, removeCacheEntries, saveToCache } from '../../db';
import {
    SPOTUBE_MATCHER_VERSION,
    buildSpotubeFallbackQuery,
    buildSpotubePrimaryQuery,
    buildSpotubeTarget,
    evaluateSpotubeMatch,
    rankSpotubeCandidates,
    scoreSpotubeCandidate,
    spotubeNeedsFallback,
} from './spotubeMatch';
import type { SpotubeMatch, SpotubeTarget } from './spotubeMatch';

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

// —— 失败归属（cooldown 算谁的账）集中在这一处 ——
//
// 设计口径：Spotube 的失败算发起方 Spotify 的账。播放核按失败的 providerId 记 cooldown，
// 归 Spotify，这首歌的重试节奏就跟其它 Spotify 歌一致；匹配目录那边的毛病也不会把整个
// Spotify 源拖进冷却。归属只有一个出口：SPOTUBE_FAILURE_OWNER 常量 + translateSpotubeFailure。
// 若日后裁定改成按来源（per-origin）归属，只动这两处：把外抛错误的 providerId 换成来源方，
// 并让 spotifyFailure 对那类错误放行不改文案——其余编排与缓存都不用动。
const SPOTUBE_FAILURE_OWNER = 'spotify' as const;

/** 匹配没命中的类型化标记：挂在 no-audio 错的 cause 上，失败文案层靠它认（spotifyFailure）。 */
export interface SpotubeNoMatchCause { spotubeNoMatch: true }

export const isSpotubeNoMatchCause = (cause: unknown): cause is SpotubeNoMatchCause => (
    typeof cause === 'object' && cause !== null && (cause as { spotubeNoMatch?: unknown }).spotubeNoMatch === true
);

// 没匹配上在 provider 层能说的就是 not-playable（答了、却没给这首歌的音频）；
// 「没有音频」这个案子（no-audio）由 describeSpotifyFailure 靠下面的标记翻出来，
// 播放核对 no-audio 不记 cooldown、不重试，只跳歌加一句提示（设计失败表）。
const spotubeNoMatchError = (song: SongResult): OnlineProviderError => new OnlineProviderError(
    'not-playable',
    `No playable match for "${song.name}".`,
    SPOTUBE_FAILURE_OWNER,
    { spotubeNoMatch: true } satisfies SpotubeNoMatchCause,
);

const httpStatusOf = (cause: unknown): number | undefined => {
    if (typeof cause !== 'object' || cause === null) return undefined;
    const status = (cause as { httpStatus?: unknown }).httpStatus ?? (cause as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
};

const retryAfterMsOf = (cause: unknown): number | undefined => {
    if (typeof cause !== 'object' || cause === null) return undefined;
    const retry = (cause as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof retry === 'number' ? retry : undefined;
};

/**
 * 把匹配与取流的失败翻成 Spotify 归属的错，三个口径（设计失败表）：
 * 登录墙/auth 类翻 not-playable——Spotify 这边是登录着的，原样报「去登录」会把用户支使错
 * 地方；其余已成信封的错换个归属原样带出；匿名路径的裸错翻 network，状态码与重试间隔
 * 透传，播放核的 1s/3s 自动重试才接得上。
 */
const translateSpotubeFailure = (cause: unknown, stage: 'search' | 'stream'): OnlineProviderError => {
    if (cause instanceof OnlineProviderError) {
        if (cause.code === 'auth-required') {
            return new OnlineProviderError('not-playable', 'The matched source refused this request.', SPOTUBE_FAILURE_OWNER, cause, cause.httpStatus, cause.retryAfterMs);
        }
        return new OnlineProviderError(cause.code, cause.message, SPOTUBE_FAILURE_OWNER, cause, cause.httpStatus, cause.retryAfterMs);
    }
    return new OnlineProviderError(
        'network',
        stage === 'search' ? 'The matching search request failed.' : 'The matched source request failed.',
        SPOTUBE_FAILURE_OWNER,
        cause,
        httpStatusOf(cause),
        retryAfterMsOf(cause),
    );
};

const SPOTUBE_SEARCH_LIMIT = 20;

const searchSpotubeCandidates = async (query: string): Promise<SongResult[]> => {
    // 懒 import：omni 加载时会反过来注册各 provider（包括 spotify 自己），顶层 import 会成环。
    const { omni } = await import('../omni');
    try {
        // session 必传：把 Spotube 的搜索跟宿主的搜索分页隔开，不传会串台。
        const page = await omni.searchProviderSongs('ytm', query, { limit: SPOTUBE_SEARCH_LIMIT, offset: 0 }, { session: 'spotube' });
        return page.items;
    } catch (cause) {
        throw translateSpotubeFailure(cause, 'search');
    }
};

const spotubeTrackIdOf = (song: SongResult): string => (
    song.sourceRef?.kind === 'online' ? String(song.sourceRef.mediaId) : String(song.id)
);

/** 日志里的时长差：一位小数秒；未知（null 或负哨兵）记 -1.0。 */
const spotubeDeltaLog = (ms: number | null): string => (ms === null || ms < 0 ? '-1.0' : (ms / 1000).toFixed(1));

const bestDeltaOf = (target: SpotubeTarget, candidates: SongResult[]): number | null => {
    if (!candidates.length) return null;
    const ranked = rankSpotubeCandidates(candidates.map(candidate => scoreSpotubeCandidate(target, candidate)));
    return ranked[0]?.durationDeltaMs ?? null;
};

/**
 * 一首 Spotify 歌 → 匹配到的录音 id。命中缓存直接用；没有就搜两次以内当场匹配并写缓存。
 * 没匹配上抛 spotubeNoMatchError（文案层翻成 no-audio）；搜索本身的失败经 translateSpotubeFailure。
 */
const matchSongToVideoId = async (song: SongResult): Promise<string> => {
    const trackId = spotubeTrackIdOf(song);
    // isrc 只在 UnifiedSong 上有这个槽（SongResult 没有）；provider 交来的本就是它自己的歌。
    const isrc = (song as UnifiedSong).isrc;
    const key = spotubeMatchCacheKey({ isrc, trackId });
    const hit = await readSpotubeMatchCache(key);
    if (hit) {
        if (hit.match.ok) {
            console.log(`[Spotube] cache hit ${trackId} -> ${hit.match.videoId} (matcher v${SPOTUBE_MATCHER_VERSION})`);
            return hit.match.videoId;
        }
        console.log(`[Spotube] unmatched ${trackId} "${song.name}" reason=${hit.match.reason} best=${hit.match.bestScore} delta=${spotubeDeltaLog(hit.bestDurationDeltaMs)}s queries=0`);
        throw spotubeNoMatchError(song);
    }
    pruneSpotubeMatchCacheOnce();
    const target = buildSpotubeTarget({
        name: song.name,
        artists: song.artists.map(artist => ({ name: artist.name })),
        album: { name: song.album.name },
        durationMs: song.durationMs,
        ...(isrc ? { isrc } : {}),
    });
    let queriesRun = 1;
    const primaryCandidates = await searchSpotubeCandidates(buildSpotubePrimaryQuery(target, song.artists[0]?.name ?? ''));
    let match = evaluateSpotubeMatch(target, primaryCandidates, 'title-artist', queriesRun);
    let bestDelta = bestDeltaOf(target, primaryCandidates);
    if (!match.ok && spotubeNeedsFallback(match, primaryCandidates.length)) {
        const fallbackQuery = buildSpotubeFallbackQuery(target);
        if (fallbackQuery) {
            queriesRun = 2;
            const fallbackCandidates = await searchSpotubeCandidates(fallbackQuery);
            const fallbackMatch = evaluateSpotubeMatch(target, fallbackCandidates, 'title-album', queriesRun);
            if (fallbackMatch.ok) {
                match = fallbackMatch;
            } else if (fallbackMatch.bestScore > match.bestScore) {
                // 两次都没中：留分数更高的那次作记录，日志与负缓存都按它说。
                match = fallbackMatch;
                bestDelta = bestDeltaOf(target, fallbackCandidates);
            }
        }
    }
    await writeSpotubeMatchCache(key, match, bestDelta);
    if (match.ok) {
        console.log(`[Spotube] matched ${trackId} -> ${match.videoId} score=${match.score} delta=${spotubeDeltaLog(match.durationDeltaMs)}s query=${match.queryShape} cached=false`);
        return match.videoId;
    }
    console.log(`[Spotube] unmatched ${trackId} "${song.name}" reason=${match.reason} best=${match.bestScore} delta=${spotubeDeltaLog(bestDelta)}s queries=${queriesRun}`);
    throw spotubeNoMatchError(song);
};

/**
 * Spotube 的取流入口（provider 的 getAudioSource 在安卓上调它）：先匹配，再拿匹配到的
 * 录音去取流。取流只需要候选的引用——拿 id 现拼一首桩歌给 omni，它按 sourceRef 找源、
 * 按 mediaId 取流；桩上其余字段用原歌的，日志与标题显示用得上。
 */
export const resolveSpotubeAudioSource = async (song: SongResult, quality: AudioQualityPreference): Promise<OmniAudioSource | null> => {
    const videoId = await matchSongToVideoId(song);
    const { omni } = await import('../omni');
    const stub: SongResult = {
        id: videoId,
        name: song.name,
        artists: song.artists,
        album: song.album,
        durationMs: song.durationMs,
        sourceRef: { kind: 'online', providerId: 'ytm', mediaId: videoId },
    };
    try {
        return await omni.getAudioSource(stub, quality);
    } catch (cause) {
        throw translateSpotubeFailure(cause, 'stream');
    }
};
