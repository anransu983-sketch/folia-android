import type { SongResult} from '../../../types';
import { createProviderSongMetadata} from '../../../utils/songMetadata';
import { normalizeLyricMatchDurationMs} from '../../../utils/lyrics/duration';
import { calculateMatchScoreDetails} from '../../../utils/lyrics/matchScore';
import type { MatchScoreDetails} from '../../../utils/lyrics/matchScore';

// src/services/onlineMusic/spotify/spotubeMatch.ts
// Spotube 的匹配规则：把一首 Spotify 歌对到另一家目录里同一段录音上。纯函数，只管查询形状、
// 打分与闸门；搜索、缓存与取流在 spotubeSource.ts。这里不点名音源平台：候选就是 omni 给的歌。

/** 匹配器版本：规则或阈值一变就 +1，缓存里的旧匹配按版本不符作废（见 spotubeSource）。 */
export const SPOTUBE_MATCHER_VERSION = 1;
/** 接受线：低于它的最佳候选也不播——播错录音比播不了更糟。 */
export const SPOTUBE_ACCEPT_SCORE = 80;
/** 回退带下沿：最佳分落在这个分数到接受线之间（或一次候选都没有）才跑回退查询。 */
export const SPOTUBE_RETRY_BAND_SCORE = 65;
/** 时长闸：双方时长都知道时，差超过它判不是同一段录音。 */
export const SPOTUBE_MAX_DURATION_DELTA_MS = 3000;

export type SpotubeTarget = { title: string; artist: string; album?: string; durationMs: number; isrc?: string};

export type SpotubeMatch =
| { ok: true; videoId: string; score: number; durationDeltaMs: number; queryShape: 'title-artist' | 'title-album'; cached: boolean}
| { ok: false; reason: 'no-candidates' | 'below-threshold' | 'duration-gate' | 'artist-gate'; bestScore: number; queriesRun: number; cached: boolean};

/** 一首候选连同它对目标的打分。durationDeltaMs 为 null 是任一侧时长未知（打分器给 0.9 乘子、时长闸放行）。 */
export interface SpotubeScoredCandidate {
song: SongResult;
details: MatchScoreDetails;
durationDeltaMs: number | null;
}

/**
* 从一首 Spotify 歌拼打分目标。artist 是全歌手拼接（打分器自己按,/&/feat 切分比对）；
* 查询串只用第一歌手，那是 spotubeSource 拼查询时的事，两边口径分开（见核验报告 ⑤-d）。
*/
export const buildSpotubeTarget = (song: {
name: string;
artists: Array<{ name: string}>;
album?: { name?: string};
durationMs: number;
isrc?: string;
}): SpotubeTarget => ({
title: song.name,
artist: song.artists.map(artist => artist.name).filter(name => name.trim()).join(', '),
...(song.album?.name?.trim()? { album: song.album.name}: {}),
durationMs: song.durationMs,
...(song.isrc? { isrc: song.isrc}: {}),
});

// 标题里给合作歌手留的后缀：查询与打分都不要它（打分器自己也会剥，这里先剥干净给搜索）。
const stripFeatSuffix = (title: string): string => title
    .replace(/\s*[\(\[（【][^\)\]）】]*\b(feat|featuring|ft)\.?[^\)\]）】]*[\)\]）】]/giu, '')
    .replace(/\b(feat|featuring|ft)\.?\s+.+$/iu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 主查询：标题（剥 feat. 后缀）+ 第一歌手。 */
export const buildSpotubePrimaryQuery = (target: SpotubeTarget, firstArtist: string): string => (
[stripFeatSuffix(target.title), firstArtist.trim()].filter(part => part).join(' ')
);

/** 回退查询：标题 + 专辑名。没有专辑名就没有回退查询，返回 null。 */
export const buildSpotubeFallbackQuery = (target: SpotubeTarget): string | null => (
target.album?.trim()? [stripFeatSuffix(target.title), target.album.trim()].filter(part => part).join(' '): null
);

/** 给一首候选打分：打分器本体是歌词自动匹配那套（权重与分桶都在它里面，这里不另算）。 */
export const scoreSpotubeCandidate = (target: SpotubeTarget, candidate: SongResult): SpotubeScoredCandidate => {
const details = calculateMatchScoreDetails(
{ title: target.title, artist: target.artist, durationMs: target.durationMs, album: target.album},
candidate,
);
const targetMs = normalizeLyricMatchDurationMs(target.durationMs);
const candidateMs = normalizeLyricMatchDurationMs(createProviderSongMetadata(candidate).durationMs);
return {
song: candidate,
details,
durationDeltaMs: targetMs > 0 && candidateMs > 0? Math.abs(targetMs - candidateMs): null,
};
};

/**
* 名次：分数高在前；同分先看专辑命中（albumMatched），再按目录自己的名次（入参顺序）。
* 名次只是同分时的裁决，永远不是接受一首的理由。
*/
export const rankSpotubeCandidates = (scored: SpotubeScoredCandidate[]): SpotubeScoredCandidate[] => (
scored
.map((entry, index) => ({ entry, index}))
.sort((a, b) => (
b.entry.details.score - a.entry.details.score
|| Number(b.entry.details.albumMatched === true) - Number(a.entry.details.albumMatched === true)
|| a.index - b.index
))
.map(({ entry}) => entry)
);

const passesGates = (entry: SpotubeScoredCandidate): boolean => (
entry.details.score >= SPOTUBE_ACCEPT_SCORE
&& entry.details.artistMatched
&& (entry.durationDeltaMs === null || entry.durationDeltaMs <= SPOTUBE_MAX_DURATION_DELTA_MS)
);

/**
* 在一批候选里定匹配：先过闸（分数、歌手、时长）再按名次取第一。
* 没有一首过闸时，unmatched 的理由按最佳候选的死法报：时长闸先于歌手闸先于分数不够。
*/
export const evaluateSpotubeMatch = (
target: SpotubeTarget,
candidates: SongResult[],
queryShape: 'title-artist' | 'title-album',
queriesRun: number,
): SpotubeMatch => {
const ranked = rankSpotubeCandidates(candidates.map(candidate => scoreSpotubeCandidate(target, candidate)));
const best = ranked[0];
if (!best) return { ok: false, reason: 'no-candidates', bestScore: 0, queriesRun, cached: false};
const winner = ranked.find(passesGates);
if (winner) {
return {
ok: true,
videoId: String(winner.song.sourceRef?.kind === 'online'? winner.song.sourceRef.mediaId: winner.song.id),
score: winner.details.score,
durationDeltaMs: winner.durationDeltaMs?? -1,
queryShape,
cached: false,
};
}
const reason = best.durationDeltaMs!== null && best.durationDeltaMs > SPOTUBE_MAX_DURATION_DELTA_MS
? 'duration-gate'
:!best.details.artistMatched? 'artist-gate': 'below-threshold';
return { ok: false, reason, bestScore: best.details.score, queriesRun, cached: false};
};

/**
* 要不要跑回退查询：一次候选都没有，或者最佳分落在回退带里。
* 闸门失败但分数已过接受线的不跑——换个查询词也改变不了那首歌的歌手或时长对不上。
*/
export const spotubeNeedsFallback = (match: SpotubeMatch, candidateCount: number): boolean => {
if (match.ok) return false;
if (candidateCount === 0) return true;
return match.bestScore >= SPOTUBE_RETRY_BAND_SCORE && match.bestScore < SPOTUBE_ACCEPT_SCORE;
};
