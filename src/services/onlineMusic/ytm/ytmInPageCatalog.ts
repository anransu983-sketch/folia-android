import { OnlineProviderError } from '../../../types/onlineMusic';
import type { YtmWireArtist, YtmWireCollection, YtmWireExploreItem, YtmWireSong } from './ytmTransport';

// src/services/onlineMusic/ytm/ytmInPageCatalog.ts
//
// 桌面端那套「解析 → wire」的页内版：逐条照 electron/ytm/catalog.cjs、webPages.cjs、
// webExplore.cjs 移植，输入换成 youtubei.js 18.1.0 在 WebView 里给的同一批解析节点
// （以及资料库标签页、歌单页的原始 JSON）。桌面端缺了这一层时是主进程在做；安卓页内
// 运行时早先把库的原始答复原样交出去，provider 按 wire 契约读不到 items，搜索恒空
// （0.7.22.5 真机实证）—— 形状对齐的唯一来源就是这里，改形状先改桌面端再同步过来。
//
// 解析节点上的文字是 Text 实例：String() 即其全文；runs 上的 endpoint 是
// NavigationEndpoint，其 payload 就是那个 endpoint 对象本体（browseEndpoint 的
// payload 里 browseId 与 pageType 并列），与原始 JSON 里多套一层的写法不同。

export const YTM_VIDEO_ID = /^[\w-]{11}$/;

type AnyRecord = Record<string, any>;

const str = (value: unknown): string => (value == null ? '' : String(value));

// 与 catalog.cjs 同一条：缩略图按宽度挑、封顶，方形小图放大到 544。
const squareArt = (url: string): string => url.replace(/=w(\d+)-h(\d+)(-[^=/]*)?$/, (match, width, height, rest = '') => (
    width === height && Number(width) < 544 ? `=w544-h544${rest}` : match
));

export const ytmThumbnailUrl = (thumbnails: unknown, maxWidth = 1200): string => {
    const byWidth = (Array.isArray(thumbnails) ? thumbnails : [])
        .filter((item: AnyRecord) => typeof item?.url === 'string')
        .sort((left: AnyRecord, right: AnyRecord) => (left.width || 0) - (right.width || 0));
    const fitting = byWidth.filter((item: AnyRecord) => (item.width || 0) <= maxWidth);
    return squareArt((fitting.at(-1) ?? byWidth[0])?.url ?? '');
};

const artistsOfParsed = (list: unknown): YtmWireArtist[] => (Array.isArray(list) ? list : [])
    .filter((artist: AnyRecord) => str(artist?.name).trim())
    .map((artist: AnyRecord) => ({ id: str(artist.channel_id), name: str(artist.name).trim() }));

const yearToTime = (value: unknown): number | undefined => {
    const year = Number(/\b(19|20)\d{2}\b/.exec(str(value))?.[0]);
    return Number.isFinite(year) && year > 0 ? Date.UTC(year, 0, 1) : undefined;
};

export interface YtmSongContext {
    artists?: YtmWireArtist[];
    albumId?: string;
    albumName?: string;
    coverUrl?: string;
}

/** 一行歌曲（搜索结果、专辑曲目、歌手热门）：照 catalog.cjs 的 songFromListItem。 */
export const ytmSongFromListItem = (item: AnyRecord, context: YtmSongContext = {}): YtmWireSong | null => {
    const id = item?.id;
    if (typeof id !== 'string' || !YTM_VIDEO_ID.test(id)) return null;
    const name = str(item.title);
    if (!name) return null;
    const artists = artistsOfParsed(item.artists?.length ? item.artists : item.authors);
    return {
        id, name,
        artists: artists.length > 0 ? artists : context.artists ?? [],
        album: {
            id: str(item.album?.id) || context.albumId || '',
            name: str(item.album?.name) || context.albumName || '',
            coverUrl: ytmThumbnailUrl(item.thumbnail?.contents ?? item.thumbnails) || context.coverUrl || '',
        },
        durationMs: Math.max(0, Number(item.duration?.seconds) || 0) * 1000,
    };
};

/** 观看队列里的一项：照 catalog.cjs 的 songFromQueueItem。 */
export const ytmSongFromQueueItem = (item: AnyRecord | undefined): YtmWireSong | null => {
    if (!item) return null;
    const id = item.video_id;
    if (typeof id !== 'string' || !YTM_VIDEO_ID.test(id)) return null;
    return {
        id, name: str(item.title),
        artists: artistsOfParsed(item.artists),
        album: { id: str(item.album?.id), name: str(item.album?.name), coverUrl: ytmThumbnailUrl(item.thumbnail) },
        durationMs: Math.max(0, Number(item.duration?.seconds) || 0) * 1000,
    };
};

/** 一张专辑卡：照 catalog.cjs 的 albumFromCard。 */
export const ytmAlbumFromCard = (item: AnyRecord, artists: YtmWireArtist[] = []): YtmWireCollection | null => {
    const id = item?.id;
    if (typeof id !== 'string' || !id.startsWith('MPRE')) return null;
    const publishedAt = yearToTime(item.year ?? item.subtitle);
    const own = artistsOfParsed(item.artists);
    return {
        id, type: 'album', name: str(item.title), coverUrl: ytmThumbnailUrl(item.thumbnail),
        artists: own.length > 0 ? own : artists,
        ...(publishedAt === undefined ? {} : { publishedAt }),
    };
};

const listIdOf = (url: unknown): string => {
    try { return new URL(str(url)).searchParams.get('list') ?? ''; } catch { return ''; }
};

/** 专辑页（库的 Album 对象）→ wire：照 catalog.cjs 的 albumFromPage。 */
export const ytmAlbumFromPage = (album: AnyRecord, id: string): { collection: YtmWireCollection; items: YtmWireSong[] } => {
    const header = album?.header ?? {};
    const playlistId = listIdOf(album?.url);
    const name = str(header.title);
    const coverUrl = ytmThumbnailUrl(header.thumbnail?.contents);
    const linked = (Array.isArray(header.strapline_text_one?.runs) ? header.strapline_text_one.runs : [])
        .filter((run: AnyRecord) => str(run?.endpoint?.payload?.browseId).startsWith('UC'))
        .map((run: AnyRecord) => ({ id: run.endpoint.payload.browseId as string, name: str(run.text).trim() }));
    const artistText = str(header.strapline_text_one).trim();
    const artists: YtmWireArtist[] = linked.length > 0 ? linked : artistText ? [{ id: '', name: artistText }] : [];
    const items = (Array.isArray(album?.contents) ? album.contents : [])
        .map((item: AnyRecord) => ytmSongFromListItem(item, { artists, albumId: id, albumName: name, coverUrl }))
        .filter((song: YtmWireSong | null): song is YtmWireSong => song !== null);
    const publishedAt = yearToTime(header.subtitle);
    return {
        collection: {
            id, type: 'album', name, coverUrl, artists, trackCount: items.length,
            description: str(header.description?.description),
            ...(playlistId ? { playlistId } : {}),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        },
        items,
    };
};

export interface YtmArtistAlbumShelf { items: YtmWireCollection[]; more: AnyRecord | null }

/** 歌手页（库的 Artist 对象）→ wire：照 catalog.cjs 的 artistFromPage，轮播的「更多」端点留给调用方展开。 */
export const ytmArtistFromPage = (artist: AnyRecord, id: string): {
    collection: YtmWireCollection;
    songs: YtmWireSong[];
    albumShelves: YtmArtistAlbumShelf[];
} => {
    const header = artist?.header ?? {};
    const name = str(header.title);
    const self: YtmWireArtist[] = [{ id, name }];
    const sections = Array.isArray(artist?.sections) ? artist.sections : [];
    const shelf = sections.find((section: AnyRecord) => section?.type === 'MusicShelf');
    const albumShelves = sections
        .filter((section: AnyRecord) => section?.type === 'MusicCarouselShelf' && section.contents?.[0]?.item_type === 'album')
        .map((section: AnyRecord) => ({
            items: (section.contents as AnyRecord[]).map(item => ytmAlbumFromCard(item, self)).filter((card): card is YtmWireCollection => card !== null),
            more: str(section.header?.more_content?.endpoint?.payload?.browseId).startsWith('MPAD')
                ? section.header.more_content.endpoint : null,
        }));
    return {
        collection: {
            id, type: 'artist', name,
            coverUrl: ytmThumbnailUrl(header.thumbnail?.contents ?? header.foreground_thumbnail?.contents),
            description: str(header.description),
        },
        songs: (Array.isArray(shelf?.contents) ? shelf.contents : [])
            .map((item: AnyRecord) => ytmSongFromListItem(item, { artists: self }))
            .filter((song: YtmWireSong | null): song is YtmWireSong => song !== null),
        albumShelves,
    };
};

/**
 * 一页歌单（Parser 解析过的 browse 答复）→ wire：照 ytmApiBridge.cjs 的 playlistPageOf。
 * `nodes` 是 youtubei.js 的 YTNodes（按类型取节点的备忘录要靠它）。以账号读到的页才
 * 传 rowIds（行自己的 id），与返回的歌曲逐首对位。
 */
export const ytmPlaylistPageOf = (
    page: AnyRecord,
    further: boolean,
    nodes: AnyRecord,
    rowIds: Array<{ videoId: string; setVideoId: string }> = [],
    trackCount?: number,
): { items: Array<YtmWireSong & { setVideoId?: string }>; continuation?: string } => {
    const left = [...rowIds];
    const withRow = (song: YtmWireSong) => {
        const at = left.findIndex(row => row.videoId === song.id);
        const setVideoId = at < 0 ? '' : left.splice(at, 1)[0].setVideoId;
        return setVideoId ? { ...song, setVideoId } : song;
    };
    const shelf = further ? undefined : page.contents_memo?.getType(nodes.MusicPlaylistShelf)?.[0];
    const rows: AnyRecord[] = [...(further
        ? page.on_response_received_actions?.find((action: AnyRecord) => action?.type === 'AppendContinuationItemsAction')?.contents ?? []
        : shelf?.contents ?? [])];
    if (further && rows.length === 0) throw new OnlineProviderError('invalid-response', 'YouTube Music playlist page has no rows', 'ytm');
    if (!further && !shelf && trackCount !== undefined && trackCount > 0) {
        throw new OnlineProviderError('invalid-response', 'YouTube Music playlist page has no rows', 'ytm');
    }
    const next = rows.find(row => row?.type === 'ContinuationItem')?.endpoint?.payload?.token ?? shelf?.continuation;
    return {
        items: rows.map(row => ytmSongFromListItem(row)).filter((song): song is YtmWireSong => song !== null).map(withRow),
        ...(typeof next === 'string' && next ? { continuation: next } : {}),
    };
};

/** 观看页里被问的那首歌：照 ytmApiBridge.cjs 的 songOfWatchPage。 */
export const ytmSongOfWatchPage = (page: AnyRecord, id: string, nodes: AnyRecord): YtmWireSong | null => {
    const entries = page.contents_memo?.getType(nodes.PlaylistPanelVideo) ?? [];
    return ytmSongFromQueueItem(entries.find((entry: AnyRecord) => entry.video_id === id)) ?? null;
};

// ---- 原始 JSON 的读法（资料库标签页、歌单页眉、歌词页）：照 webPages.cjs / catalog.cjs ----

/** 原始 JSON 里一处文字节点：simpleText 或 runs 拼起来（webPages.cjs 的 textOf）。 */
const rawTextOf = (node: AnyRecord): string => {
    if (typeof node?.simpleText === 'string') return node.simpleText;
    return Array.isArray(node?.runs) ? node.runs.map((run: AnyRecord) => run?.text ?? '').join('') : '';
};

const countIn = (text: unknown): number | undefined => {
    const count = [...String(text).matchAll(/(?<!\d[.,   ]?)(\d+(?:[.,   ]\d{3})*)\s*(?:首歌曲|首曲目|(?:songs?|videos?|tracks?|lagu)\b)/gi)].at(-1)?.[1];
    return count ? Number(count.replace(/[.,   ]/g, '')) : undefined;
};

const holds = (value: unknown, keys: string[]): boolean => Boolean(value) && typeof value === 'object'
    && Object.entries(value as AnyRecord).some(([key, child]) => keys.includes(key) || holds(child, keys));

/** 资料库标签页的一页卡片与下一页令牌（webPages.cjs 的 readGrid）。 */
export const ytmReadGrid = (data: unknown): { rows: AnyRecord[]; continuation?: string } => {
    let grid: AnyRecord | undefined;
    const visit = (value: unknown): void => {
        if (grid || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        for (const [key, child] of Object.entries(value as AnyRecord)) {
            if (key === 'gridRenderer' || key === 'gridContinuation') grid ??= child as AnyRecord;
            else visit(child);
        }
    };
    visit(data);
    const rows = (Array.isArray(grid?.items) ? grid.items : [])
        .map((item: AnyRecord) => item?.musicTwoRowItemRenderer).filter(Boolean);
    const continuation = grid?.continuations?.[0]?.nextContinuationData?.continuation;
    return { rows, ...(typeof continuation === 'string' && continuation ? { continuation } : {}) };
};

/** 资料库标签页上的一张歌单/专辑卡（webPages.cjs 的 collectionFromRow）；别的卡返回 null。 */
export const ytmCollectionFromRow = (row: AnyRecord): YtmWireCollection | null => {
    const browseId = row?.navigationEndpoint?.browseEndpoint?.browseId;
    const name = rawTextOf(row?.title).trim();
    if (typeof browseId !== 'string' || !name) return null;
    const coverUrl = ytmThumbnailUrl(row.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails);
    const runs = Array.isArray(row.subtitle?.runs) ? row.subtitle.runs : [];
    const lastWords = String(runs.at(-1)?.text ?? '');
    if (browseId.startsWith('MPRE')) {
        const playlistId = row.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
            ?.playNavigationEndpoint?.watchPlaylistEndpoint?.playlistId;
        const artists = runs
            .map((run: AnyRecord) => ({ id: run?.navigationEndpoint?.browseEndpoint?.browseId, name: String(run?.text ?? '').trim() }))
            .filter((artist: AnyRecord) => typeof artist.id === 'string' && artist.id.startsWith('UC') && artist.name);
        return {
            id: browseId, type: 'album', name, coverUrl,
            ...(typeof playlistId === 'string' && playlistId ? { playlistId } : {}),
            artists,
            ...(/^(19|20)\d{2}$/.test(lastWords.trim()) ? { year: Number(lastWords) } : {}),
        };
    }
    if (!browseId.startsWith('VL') || browseId.length < 4) return null;
    const id = browseId.slice(2);
    const count = countIn(lastWords);
    return {
        id, type: 'playlist', name, coverUrl,
        ...(count !== undefined ? { trackCount: count } : {}),
        ...(id === 'LM' ? { isLiked: true } : {}),
        ...(holds(row.menu, ['playlistEditorEndpoint', 'deletePlaylistEndpoint']) ? { isOwned: true } : {}),
    };
};

const ROW_ID = /^[\w-]{1,64}$/;
const PLAYLIST_ROW_LISTS = ['musicPlaylistShelfRenderer', 'musicPlaylistShelfContinuation', 'appendContinuationItemsAction'];

/** 歌单页原始 JSON 里每一行自己的 id（webPages.cjs 的 playlistRowsOf）。 */
export const ytmPlaylistRowsOf = (data: unknown): Array<{ videoId: string; setVideoId: string }> => {
    const rows: Array<{ videoId: string; setVideoId: string }> = [];
    const visit = (value: unknown, within: boolean): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(item => visit(item, within)); return; }
        for (const [key, child] of Object.entries(value as AnyRecord)) {
            const row = within && key === 'musicResponsiveListItemRenderer' ? (child as AnyRecord)?.playlistItemData : undefined;
            if (!row) { visit(child, within || PLAYLIST_ROW_LISTS.includes(key)); continue; }
            const { videoId, playlistSetVideoId: setVideoId } = row as AnyRecord;
            if (typeof videoId === 'string') {
                rows.push({ videoId, setVideoId: typeof setVideoId === 'string' && ROW_ID.test(setVideoId) ? setVideoId : '' });
            }
        }
    };
    visit(data, false);
    return rows;
};

const PLAYLIST_HEADERS = ['musicResponsiveHeaderRenderer', 'musicDetailHeaderRenderer'];

/** 歌单页页眉里写的歌曲数（webPages.cjs 的 playlistCountOf）；没写就是 undefined。 */
export const ytmPlaylistCountOf = (data: unknown): number | undefined => {
    let line: string | undefined;
    const visit = (value: unknown): void => {
        if (line !== undefined || !value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as AnyRecord)) {
            if (PLAYLIST_HEADERS.includes(key) && (child as AnyRecord)?.secondSubtitle) line ??= rawTextOf((child as AnyRecord).secondSubtitle);
            else visit(child);
        }
    };
    visit(data);
    return line === undefined ? undefined : countIn(line);
};

/** 一首歌的歌词页 browseId（catalog.cjs 的 lyricsBrowseId，读观看页原始 JSON）。 */
export const ytmLyricsBrowseId = (watchPage: AnyRecord): string | null => {
    const tabs = watchPage?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs ?? [];
    for (const tab of tabs) {
        const endpoint = tab?.tabRenderer?.endpoint?.browseEndpoint;
        const pageType = endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
        if (pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS' && typeof endpoint.browseId === 'string') return endpoint.browseId;
    }
    return null;
};

const lrcTime = (ms: number): string => {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
    return `[${String(minutes).padStart(2, '0')}:${seconds}]`;
};

/** 手机端歌词页（原始 JSON）→ 带时间的 LRC 文本（catalog.cjs 的 lrcFromLyricsPage）。 */
export const ytmLrcFromLyricsPage = (page: AnyRecord): string | null => {
    const timed = page?.contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel
        ?.lyricsData?.timedLyricsData;
    if (!Array.isArray(timed)) return null;
    const lines: string[] = [];
    for (const entry of timed) {
        const text = typeof entry?.lyricLine === 'string' ? entry.lyricLine.replace(/\s+/g, ' ').trim() : '';
        const startMs = Number(entry?.cueRange?.startTimeMilliseconds);
        if (/[\p{L}\p{N}]/u.test(text) && Number.isFinite(startMs) && startMs >= 0) lines.push(`${lrcTime(startMs)}${text}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
};

// ---- 发现页（首页 feed 的解析节点）：照 webExplore.cjs 的条目读法 ----

const EXPLORE_LIST_ID = /^[\w-]{2,128}$/;
const EXPLORE_ARTIST_ID = /^UC[\w-]{10,62}$/;

const parsedPageTypeOf = (endpoint: AnyRecord): string | undefined => (
    endpoint?.payload?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
);

/** 一行文字里带链接的歌手（webExplore.cjs 的 artistsOf，端点换成解析节点的 payload）。 */
const artistsOfParsedLine = (line: AnyRecord): YtmWireArtist[] => (Array.isArray(line?.runs) ? line.runs : [])
    .filter((run: AnyRecord) => EXPLORE_ARTIST_ID.test(run?.endpoint?.payload?.browseId ?? '') && run.text?.trim())
    .map((run: AnyRecord) => ({
        id: parsedPageTypeOf(run.endpoint) === 'MUSIC_PAGE_TYPE_ARTIST' ? run.endpoint.payload.browseId as string : '',
        name: str(run.text).trim(),
    }));

const exploreItemLeadingTo = (
    endpoint: AnyRecord,
    named: { name: string; coverUrl: string; artists: YtmWireArtist[]; albumLine?: AnyRecord },
): YtmWireExploreItem | null => {
    const { name, coverUrl, artists, albumLine } = named;
    const payload = endpoint?.payload ?? {};
    if (endpoint?.name === 'watchEndpoint') {
        const videoId = payload.videoId;
        if (typeof videoId !== 'string' || !YTM_VIDEO_ID.test(videoId)) return null;
        const album = (Array.isArray(albumLine?.runs) ? albumLine.runs : [])
            .find((run: AnyRecord) => parsedPageTypeOf(run?.endpoint) === 'MUSIC_PAGE_TYPE_ALBUM')
            ?.endpoint?.payload?.browseId;
        return { kind: 'song', song: { id: videoId, name, artists, album: { id: album ?? '', name: album ? str(albumLine).trim() : '', coverUrl }, durationMs: 0 } };
    }
    if (endpoint?.name === 'watchPlaylistEndpoint') {
        const played = payload.playlistId;
        if (typeof played !== 'string' || !EXPLORE_LIST_ID.test(played)) return null;
        return { kind: 'collection', collection: { id: played, type: 'playlist', name, coverUrl, ...(played.startsWith('RD') ? { mix: true } : {}) } };
    }
    if (endpoint?.name !== 'browseEndpoint') return null;
    const id = payload.browseId;
    if (typeof id !== 'string') return null;
    switch (parsedPageTypeOf(endpoint)) {
        case 'MUSIC_PAGE_TYPE_ALBUM':
            return id.startsWith('MPRE') && EXPLORE_LIST_ID.test(id)
                ? { kind: 'collection', collection: { id, type: 'album', name, coverUrl, artists } } : null;
        case 'MUSIC_PAGE_TYPE_PLAYLIST': {
            const playlistId = id.slice(2);
            if (!id.startsWith('VL') || !EXPLORE_LIST_ID.test(playlistId)) return null;
            return { kind: 'collection', collection: { id: playlistId, type: 'playlist', name, coverUrl, ...(playlistId === 'LM' ? { isLiked: true } : {}) } };
        }
        case 'MUSIC_PAGE_TYPE_ARTIST':
            return EXPLORE_ARTIST_ID.test(id) ? { kind: 'collection', collection: { id, type: 'artist', name, coverUrl } } : null;
        default:
            return null;
    }
};

/** 首页 feed 里一个条目（两行卡或列表行）→ wire（webExplore.cjs 的 exploreItemFromEntry）。 */
export const ytmExploreItemFromEntry = (entry: AnyRecord): YtmWireExploreItem | null => {
    const isCard = entry?.type === 'MusicTwoRowItem';
    const isRow = entry?.type === 'MusicResponsiveListItem';
    if (!isCard && !isRow) return null;
    const columns = isRow ? (Array.isArray(entry.flex_columns) ? entry.flex_columns : []) : [];
    const title = isCard ? entry.title : columns[0]?.text;
    const name = str(title).trim();
    const endpoint = entry.endpoint ?? title?.runs?.[0]?.endpoint ?? title?.endpoint;
    if (!name || !endpoint) return null;
    const thumbnails = isCard ? entry.thumbnail : entry.thumbnail?.contents;
    const coverUrl = ytmThumbnailUrl(thumbnails);
    const item = exploreItemLeadingTo(endpoint, {
        name, coverUrl,
        artists: artistsOfParsedLine(isCard ? entry.subtitle : columns[1]?.text),
        albumLine: isRow ? columns[2]?.text : undefined,
    });
    const isWide = (Array.isArray(thumbnails) ? thumbnails : []).some((picture: AnyRecord) => picture?.width > picture?.height);
    return item && isWide ? { ...item, wideCoverUrl: coverUrl } : item;
};

/** 首页 feed 的一页架子（空架子不留）：标题与条目都按 wire 形状。 */
export const ytmExploreSectionsOf = (feed: AnyRecord): Array<{ title: string; items: YtmWireExploreItem[] }> => (
    (Array.isArray(feed?.sections) ? feed.sections : [])
        .filter((shelf: AnyRecord) => shelf?.type === 'MusicCarouselShelf')
        .map((shelf: AnyRecord) => ({
            title: str(shelf.header?.title).trim(),
            items: (Array.isArray(shelf.contents) ? shelf.contents : [])
                .map((entry: AnyRecord) => ytmExploreItemFromEntry(entry))
                .filter((item): item is YtmWireExploreItem => item !== null),
        }))
        .filter((section: { items: YtmWireExploreItem[] }) => section.items.length > 0)
);
