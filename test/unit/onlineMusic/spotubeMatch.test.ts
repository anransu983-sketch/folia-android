import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import type { MatchScoreDetails } from '@/utils/lyrics/matchScore';
import {
    SPOTUBE_ACCEPT_SCORE,
    SPOTUBE_MATCHER_VERSION,
    SPOTUBE_MAX_DURATION_DELTA_MS,
    SPOTUBE_RETRY_BAND_SCORE,
    buildSpotubeFallbackQuery,
    buildSpotubePrimaryQuery,
    buildSpotubeTarget,
    evaluateSpotubeMatch,
    rankSpotubeCandidates,
    scoreSpotubeCandidate,
    spotubeNeedsFallback,
} from '@/services/onlineMusic/spotify/spotubeMatch';
import type { SpotubeScoredCandidate, SpotubeTarget } from '@/services/onlineMusic/spotify/spotubeMatch';

// test/unit/onlineMusic/spotubeMatch.test.ts
// Spotube 的匹配规则。期望分数全部是打分器在这些夹具上的实测值（含它的 74 分封顶与时长未知
// 0.9 乘子），不是按权重裸算的——打分器改了行为，这里先红。

const target: SpotubeTarget = { title: 'Blue Skies', artist: 'Ella Moss', album: 'Azure', durationMs: 200_000 };

const candidate = (id: string, name: string, artist: string, album: string, durationMs: number): SongResult => ({
    id,
    name,
    artists: [{ id: `artist-${id}`, name: artist }],
    album: { id: `album-${id}`, name: album },
    durationMs,
    sourceRef: { kind: 'online', providerId: 'ytm', mediaId: id },
});

const exact = (id: string, durationMs = 200_400) => candidate(id, 'Blue Skies', 'Ella Moss', 'Azure', durationMs);

describe('spotube matcher constants', () => {
    it('pins the thresholds the design set', () => {
        expect(SPOTUBE_MATCHER_VERSION).toBe(1);
        expect(SPOTUBE_ACCEPT_SCORE).toBe(80);
        expect(SPOTUBE_RETRY_BAND_SCORE).toBe(65);
        expect(SPOTUBE_MAX_DURATION_DELTA_MS).toBe(3000);
    });
});

describe('buildSpotubeTarget', () => {
    it('joins every artist for scoring and keeps album and isrc', () => {
        const built = buildSpotubeTarget({
            name: 'Duet Song',
            artists: [{ name: 'Ella Moss' }, { name: 'June Park' }],
            album: { name: 'Azure' },
            durationMs: 200_000,
            isrc: 'USRC10000001',
        });
        expect(built).toEqual({ title: 'Duet Song', artist: 'Ella Moss, June Park', album: 'Azure', durationMs: 200_000, isrc: 'USRC10000001' });
    });

    it('scores a duet by its full artist list, not the first artist alone', () => {
        // 实测：全拼接时歌手相似度 1.0（100 分），只给第一歌手时 0.7（93 分）。
        const duet = candidate('duet', 'Duet Song', 'Ella Moss', 'Azure', 200_000);
        duet.artists = [{ id: 'a1', name: 'Ella Moss' }, { id: 'a2', name: 'June Park' }];
        const full = scoreSpotubeCandidate({ title: 'Duet Song', artist: 'Ella Moss, June Park', album: 'Azure', durationMs: 200_000 }, duet);
        const firstOnly = scoreSpotubeCandidate({ title: 'Duet Song', artist: 'Ella Moss', album: 'Azure', durationMs: 200_000 }, duet);
        expect(full.details.artistSimilarity).toBe(1);
        expect(full.details.score).toBe(100);
        expect(firstOnly.details.artistSimilarity).toBeCloseTo(0.7);
        expect(firstOnly.details.score).toBe(93);
    });

    it('leaves album out when the row has none worth naming', () => {
        const built = buildSpotubeTarget({ name: 'Song', artists: [{ name: 'Ella Moss' }], album: { name: '  ' }, durationMs: 1000 });
        expect(built.album).toBeUndefined();
        expect(built.isrc).toBeUndefined();
    });
});

describe('spotube queries', () => {
    it('builds the primary query from the title without its feat. suffix and the first artist', () => {
        const withFeat: SpotubeTarget = { title: 'Sunset Drive (feat. June Park)', artist: 'Ella Moss, June Park', durationMs: 200_000 };
        expect(buildSpotubePrimaryQuery(withFeat, 'Ella Moss')).toBe('Sunset Drive Ella Moss');
        expect(buildSpotubePrimaryQuery(target, 'Ella Moss')).toBe('Blue Skies Ella Moss');
    });

    it('builds the fallback query from title and album, and none without an album', () => {
        expect(buildSpotubeFallbackQuery(target)).toBe('Blue Skies Azure');
        expect(buildSpotubeFallbackQuery({ title: 'Blue Skies', artist: 'Ella Moss', durationMs: 200_000 })).toBeNull();
    });
});

describe('evaluateSpotubeMatch', () => {
    it('matches the studio recording half a second out', () => {
        const match = evaluateSpotubeMatch(target, [exact('v1')], 'title-artist', 1);
        expect(match).toEqual({ ok: true, videoId: 'v1', score: 100, durationDeltaMs: 400, queryShape: 'title-artist', cached: false });
    });

    it('still matches two seconds out, inside the duration gate', () => {
        const match = evaluateSpotubeMatch(target, [exact('v1', 202_000)], 'title-artist', 1);
        expect(match).toMatchObject({ ok: true, score: 95, durationDeltaMs: 2000 });
    });

    it('rejects four seconds out at the duration gate, in the fallback band', () => {
        const match = evaluateSpotubeMatch(target, [exact('v1', 204_000)], 'title-artist', 1);
        expect(match).toEqual({ ok: false, reason: 'duration-gate', bestScore: 75, queriesRun: 1, cached: false });
        expect(spotubeNeedsFallback(match, 1)).toBe(true);
    });

    it('rejects twelve seconds out below the fallback band', () => {
        const match = evaluateSpotubeMatch(target, [exact('v1', 212_000)], 'title-artist', 1);
        expect(match).toMatchObject({ ok: false, reason: 'duration-gate', bestScore: 10 });
        expect(spotubeNeedsFallback(match, 1)).toBe(false);
    });

    it('rejects the live version', () => {
        const live = candidate('live', 'Blue Skies (Live)', 'Ella Moss', 'Azure Live', 206_000);
        const match = evaluateSpotubeMatch(target, [live], 'title-artist', 1);
        expect(match).toMatchObject({ ok: false, reason: 'duration-gate', bestScore: 25 });
    });

    it('caps a remix whose title did not match at 74, however strong the rest is', () => {
        // 打分器的封顶：title 未命中时身份分先封 74。裸算身份分是 83，过不了接受线。
        const remix = candidate('remix', 'Blue Skies (Remix)', 'Ella Moss', 'Azure', 201_000);
        const scored = scoreSpotubeCandidate(target, remix);
        expect(scored.details.titleMatched).toBe(false);
        expect(scored.details.titleScore + scored.details.artistScore + scored.details.albumScore).toBeGreaterThan(80);
        expect(scored.details.score).toBe(74);
        expect(evaluateSpotubeMatch(target, [remix], 'title-artist', 1)).toMatchObject({ ok: false, bestScore: 74 });
    });

    it('caps a title miss at 74 even with artist and album exact', () => {
        const other = candidate('other', 'Green Skies', 'Ella Moss', 'Azure', 200_000);
        const scored = scoreSpotubeCandidate(target, other);
        expect(scored.details.score).toBe(74);
        expect(evaluateSpotubeMatch(target, [other], 'title-artist', 1)).toMatchObject({ ok: false, reason: 'below-threshold', bestScore: 74 });
    });

    it('rejects a cover by another artist at the artist gate, though its 83 clears the score line', () => {
        // 专辑命中让身份可靠、不吃封顶，分数实打实 83——只有显式歌手闸拦得住它。
        const cover = candidate('cover', 'Blue Skies', 'Cover Band', 'Azure', 200_000);
        const scored = scoreSpotubeCandidate(target, cover);
        expect(scored.details.score).toBe(83);
        expect(scored.details.artistMatched).toBe(false);
        expect(scored.details.albumMatched).toBe(true);
        const match = evaluateSpotubeMatch(target, [cover], 'title-artist', 1);
        expect(match).toEqual({ ok: false, reason: 'artist-gate', bestScore: 83, queriesRun: 1, cached: false });
        // 闸门失败不跑回退查询：换个查询词改变不了歌手对不上。
        expect(spotubeNeedsFallback(match, 1)).toBe(false);
    });

    it('matches a candidate whose duration is unknown, at the 0.9 multiplier, and marks the delta unknown', () => {
        const unknown = candidate('nodur', 'Blue Skies', 'Ella Moss', 'Azure', 0);
        const scored = scoreSpotubeCandidate(target, unknown);
        expect(scored.details.durationMultiplier).toBe(0.9);
        expect(scored.durationDeltaMs).toBeNull();
        const match = evaluateSpotubeMatch(target, [unknown], 'title-artist', 1);
        expect(match).toMatchObject({ ok: true, score: 90, durationDeltaMs: -1 });
    });

    it('marks a target whose Spotify duration read as 0 the same way', () => {
        // Spotify 行时长读出 0 不是歌长 0，是未知：乘子 0.9、时长闸放行、delta 记 -1。
        const zeroTarget: SpotubeTarget = { ...target, durationMs: 0 };
        const match = evaluateSpotubeMatch(zeroTarget, [exact('v1', 200_000)], 'title-artist', 1);
        expect(match).toMatchObject({ ok: true, score: 90, durationDeltaMs: -1 });
    });

    it('matches a CJK title exactly', () => {
        const cjkTarget: SpotubeTarget = { title: '夜空中最亮的星', artist: '逃跑计划', album: '世界', durationMs: 252_000 };
        const cjk = candidate('cjk', '夜空中最亮的星', '逃跑计划', '世界', 253_000);
        expect(evaluateSpotubeMatch(cjkTarget, [cjk], 'title-artist', 1)).toMatchObject({ ok: true, videoId: 'cjk', score: 100 });
    });

    it('reports no candidates and asks for the fallback query', () => {
        const match = evaluateSpotubeMatch(target, [], 'title-artist', 1);
        expect(match).toEqual({ ok: false, reason: 'no-candidates', bestScore: 0, queriesRun: 1, cached: false });
        expect(spotubeNeedsFallback(match, 0)).toBe(true);
    });

    it('picks a passing candidate over a higher-scored one the gates reject', () => {
        const cover = candidate('cover', 'Blue Skies', 'Cover Band', 'Azure', 200_000);
        const match = evaluateSpotubeMatch(target, [cover, exact('v1')], 'title-artist', 1);
        expect(match).toMatchObject({ ok: true, videoId: 'v1', score: 100 });
    });
});

describe('rankSpotubeCandidates', () => {
    const details = (score: number, albumMatched: boolean | null): MatchScoreDetails => ({
        score, titleScore: 0, artistScore: 0, albumScore: 0, durationScore: 0, durationMultiplier: 1,
        titleSimilarity: 0, artistSimilarity: 0, albumSimilarity: null,
        titleMatched: true, artistMatched: true, albumMatched, durationMatched: true,
    });
    const entry = (id: string, score: number, albumMatched: boolean | null): SpotubeScoredCandidate => ({
        song: candidate(id, 'Blue Skies', 'Ella Moss', 'Azure', 200_000), details: details(score, albumMatched), durationDeltaMs: 0,
    });

    it('breaks a tie toward the album match, then toward the source rank', () => {
        const ranked = rankSpotubeCandidates([entry('plain', 90, false), entry('album', 90, true), entry('third', 90, true)]);
        expect(ranked.map(item => item.song.id)).toEqual(['album', 'third', 'plain']);
    });

    it('keeps score order before any tie-break', () => {
        const ranked = rankSpotubeCandidates([entry('low', 70, true), entry('high', 95, false)]);
        expect(ranked.map(item => item.song.id)).toEqual(['high', 'low']);
    });
});
