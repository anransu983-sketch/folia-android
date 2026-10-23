import { OnlineProviderError } from '../../../types/onlineMusic';
import type { LoginDiagnosticLine, ProviderUser } from '../../../types/onlineMusic';
import { createNativeFetch } from '../../../services/nativeHttpFetch';
import { diagnosticLine, formatDiagnosticClock } from '../login/loginDiagnosticReport';
import {
    isSpotifyNativeAvailable,
    refreshSpotifyNativeSession,
    requestSpotifyNativeSignIn,
} from './spotifyNative';
import { spotifyId } from './spotifyNormalize';

// src/services/onlineMusic/spotify/spotifyInPageRuntime.ts
//
// 安卓上的 Spotify 取数层：走**公开 Web API**（api.spotify.com），跑在主 WebView 里。
//
// 为什么不是桌面端那一套：桌面端的 `query` 是 librespot 的**内部接口**（home / libraryV3 /
// searchTracks 那 12 个名字），背后是 protobuf 与 Spotify 自己的私有端点，安卓上拿不到
// librespot（`@lox-audioserver/node-librespot` 是原生 Node 模块，没有 android-arm64 预编译）。
//
// ⚠️ 而公开 Web API 给的 JSON **与桌面端那套内部形状完全不同**（那边是
// `searchV2.tracksV2.items[].item.data`，这边是 `tracks.items[]`）。所以这一层不是「转发」，
// 是**翻译**：每一次查询在返回前折回桌面端的形状（见下面的 trackOf / albumOf 等），
// 于是 spotifyProvider / spotifyCatalog / spotifyLibrary / spotifyNormalize 一行都不用改。
// 反过来（改下游去适配两种形状）会让每个解析点都长出一条安卓分支，那是留不得的。
//
// 请求走原生 OkHttp 桥而不是直接 fetch：WebView 里的页面是有来源的，跨域要走同源检查。
// （api.spotify.com 本来是给了 CORS 头的，但这条路与另一家共用一份实现，一并避开
// 各家 ROM 对 WebView 网络策略的差别。）
//
// 原生只管 OAuth：收回调需要本地端口（5588），换 token 会撞 CORS，两件 WebView 都做不了。

const API = 'https://api.spotify.com/v1';
/** 公开 API 一页最多 50 行；下游按「实际给了几行」翻页，少给只是多请求几次。 */
const MAX_ROWS = 50;
/** 一次登录最多等这么久，与原生侧（FoliaSpotifyPlugin）一致。 */
const LOGIN_TTL_MS = 10 * 60 * 1000;

/** 桌面端那 12 个 query 里，公开 Web API 没有对应物件的。 */
const UNSUPPORTED_QUERIES = new Set(['home', 'homeSection', 'browsePage', 'queryWhatsNewFeed']);
// 播歌与写操作：本轮不做（播歌要 librespot，写操作等取数稳了再说）。
const UNSUPPORTED = new Set(['audio', 'audio_kept', 'audio_keep', 'radio', 'playlist_edit', 'playlist_create']);

type Session = {
    accessToken: string;
    refreshToken: string;
    /** 过期时刻（epoch ms）。 */
    expiresAtMs: number;
};

let session: Session | null = null;

export const isSignedInSpotifyInPage = (): boolean => session !== null;

/** token 快过期就先续一次（提前 60 秒）。 */
const ensureFreshToken = async (): Promise<string> => {
    if (!session) throw new OnlineProviderError('auth-required', 'Spotify is not signed in', 'spotify');
    if (Date.now() < session.expiresAtMs - 60_000) return session.accessToken;
    if (!isSpotifyNativeAvailable() || !session.refreshToken) return session.accessToken;
    const result = await refreshSpotifyNativeSession(session.refreshToken);
    if (!result.ok) throw new OnlineProviderError('auth-required', result.error.message, 'spotify', result.error.code);
    const { accessToken, refreshToken, expiresInMs } = result.session;
    session = { accessToken, refreshToken: refreshToken || session.refreshToken, expiresAtMs: Date.now() + expiresInMs };
    return session.accessToken;
};

/*
 * 安卓上请求由原生的 OkHttp 发出，而它**默认不带 User-Agent**（OkHttp 不像浏览器那样自己
 * 补头），httpRequest 也只带上调用方给的那几个。于是公开 API 收到的是一个连 UA 都没有的
 * 请求 —— 那种请求被当成脚本而拒掉（401 / 403）是常见做法。这里按浏览器的样子补上。
 */
const REQUEST_HEADERS = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
} as const;

/*
 * 429 的退避时长只在 `Retry-After` 头里（单位是秒），读不到就不给。
 *
 * ⚠️ 这个头**必须读**：2026-10-19 的登录报告里，OAuth 已经成了（access token 有效 3589 秒、
 * refresh token 也在），紧接着那一次 `GET /me` 被限流回 429；当时没有任何一处读这个头，
 * 于是限流被当成「读不到账号」，一次成功的登录被整笔丢掉（account-refresh-failed）。
 */
const readRetryAfterMs = (response: Response): number | undefined => {
    const raw = response.headers?.get?.('Retry-After')?.trim();
    if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return undefined;
    const ms = Math.round(Number(raw) * 1000);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

const call = async (path: string, token: string): Promise<any> => {
    const response = await createNativeFetch()(`${API}${path}`, {
        headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) throw new OnlineProviderError('auth-required', 'Spotify said the sign-in is no longer valid', 'spotify');
    if (response.status === 403) throw new OnlineProviderError('not-playable', 'Spotify refused this request', 'spotify');
    if (!response.ok) {
        // 状态与「要等多久」挂在错上：共用的失败规则认的是 `httpStatus` / `retryAfterMs`，
        // 只看 `code` 的话 429 与真的连不上是同一件事（都是 network）。
        throw new OnlineProviderError(
            'network',
            `Spotify answered ${response.status}`,
            'spotify',
            undefined,
            response.status,
            readRetryAfterMs(response),
        );
    }
    return response.json().catch(() => null);
};

// ─── 形状翻译：公开 Web API → 桌面端那套内部形状 ────────────────────────────────────
// 下面每个 `…Of` 的字段名都对着 spotifyNormalize.ts 里那几个 interface，改那边要一起改。

type WebImage = { url?: string; width?: number | null };

const sources = (images: WebImage[] | undefined): Array<{ url: string; width: number | null }> => (
    (images ?? []).map(image => ({ url: String(image?.url ?? ''), width: image?.width ?? null }))
);

const artistRow = (artist: any): any => ({
    uri: String(artist?.uri ?? (artist?.id ? `spotify:artist:${artist.id}` : '')),
    profile: { name: String(artist?.name ?? '') },
});

const trackOf = (track: any): any => {
    if (!track) return null;
    const album = track.album;
    return {
        __typename: 'Track',
        uri: String(track.uri ?? (track.id ? `spotify:track:${track.id}` : '')),
        name: String(track.name ?? ''),
        artists: { items: (track.artists ?? []).map(artistRow) },
        // 专辑里的曲目是「简化曲目」，没有 album 字段 —— 那由读取方用「它所在的专辑」补上
        // （spotifyCatalog.getAlbumTracks 就是把 beside.album 传进去的）。
        ...(album ? {
            albumOfTrack: {
                uri: String(album.uri ?? (album.id ? `spotify:album:${album.id}` : '')),
                name: String(album.name ?? ''),
                coverArt: { sources: sources(album.images) },
            },
        } : {}),
        duration: { totalMilliseconds: Number(track.duration_ms ?? 0) || 0 },
    };
};

const albumOf = (album: any): any => {
    const releaseDate = String(album?.release_date ?? '');
    const year = Number(releaseDate.slice(0, 4)) || undefined;
    return {
        __typename: 'Album',
        uri: String(album?.uri ?? (album?.id ? `spotify:album:${album.id}` : '')),
        name: String(album?.name ?? ''),
        coverArt: { sources: sources(album?.images) },
        artists: { items: (album?.artists ?? []).map(artistRow) },
        // 公开 API 只给一个日期字符串，精度随专辑而定（年 / 月 / 日都有），交给那边解析。
        date: { ...(releaseDate ? { isoString: releaseDate } : {}), ...(year ? { year } : {}) },
        albumType: String(album?.album_type ?? ''),
        tracks: { totalCount: Number(album?.total_tracks ?? 0) || 0 },
    };
};

const artistOf = (artist: any): any => ({
    uri: String(artist?.uri ?? (artist?.id ? `spotify:artist:${artist.id}` : '')),
    profile: { name: String(artist?.name ?? '') },
    visuals: { avatarImage: { sources: sources(artist?.images) } },
});

const playlistOf = (playlist: any): any => ({
    __typename: 'Playlist',
    uri: String(playlist?.uri ?? (playlist?.id ? `spotify:playlist:${playlist.id}` : '')),
    name: String(playlist?.name ?? ''),
    description: String(playlist?.description ?? ''),
    images: { items: [{ sources: sources(playlist?.images) }] },
    ownerV2: { data: { name: String(playlist?.owner?.display_name ?? '') } },
    content: { totalCount: Number(playlist?.tracks?.total ?? 0) || 0 },
});

// ─── 参数读取 ────────────────────────────────────────────────────────────────────

/** `spotify:track:xxx` 与裸 id 都认：调用方两种都给。 */
const idOf = (value: unknown): string => {
    const text = String(value ?? '').trim();
    const tail = text.split(':').pop() ?? '';
    return /^[0-9A-Za-z]{22}$/.test(tail) ? tail : text;
};

const clampRows = (value: unknown): number => {
    const asked = Number(value ?? MAX_ROWS);
    if (!Number.isFinite(asked) || asked <= 0) return MAX_ROWS;
    return Math.min(MAX_ROWS, Math.round(asked));
};

const offsetOf = (value: unknown): number => {
    const offset = Number(value ?? 0);
    return Number.isFinite(offset) && offset > 0 ? Math.round(offset) : 0;
};

export const signOutSpotifyInPage = (): void => {
    session = null;
};

/*
 * 最近一次「登录进去的是谁」的结论。
 *
 * 为什么必须有它：登录确认之后读账号那一步失败时（account-refresh-failed），界面只说
 * 「没读到账号」，而报告里 provider 那一段原来是空的（"(none)"）—— 因为 Spotify 没实现
 * `auth.getLoginDiagnostics`。另外几家早就靠这一行指出卡在哪的：没存下会话、
 * 平台不认这个会话、还是请求本身失败了。
 */
let lastLoginStatusCheck: LoginDiagnosticLine | null = null;
const noteLoginStatusCheck = (summary: LoginDiagnosticLine): void => {
    lastLoginStatusCheck = diagnosticLine`${formatDiagnosticClock(Date.now())} ${summary}`;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 读 /me 撞上限流或服务抖动时最多问这么几次（含第一次）。 */
const ME_READ_ATTEMPTS = 3;
/** 重试前等的时长：平台说了就听它的，但不让人干等几十秒，也不至于立刻又撞上去。 */
const ME_READ_WAIT_MIN_MS = 1000;
const ME_READ_WAIT_MAX_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * 这个错算不算「等一会儿再问一次就成了」：429（限流）和 5xx（服务端出错）算，回要等多少毫秒。
 *
 * ⚠️ 401 不算：那是这个登录真的不算数，再问多少次都一样，而且必须回到 null（见下面
 * readSignedInUser 的说明）。把限流和它分开，才不会让一次限流把刚登进去的账号整笔丢掉。
 */
const meReadWaitMsOf = (error: unknown): number | null => {
    if (!(error instanceof OnlineProviderError)) return null;
    const status = error.httpStatus;
    if (status !== 429 && !(typeof status === 'number' && status >= 500)) return null;
    const asked = typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
    return Math.min(ME_READ_WAIT_MAX_MS, Math.max(ME_READ_WAIT_MIN_MS, asked));
};

const askMe = async (): Promise<any> => {
    let attempt = 1;
    for (;;) {
        try {
            return await call('/me', await ensureFreshToken());
        } catch (error) {
            const waitMs = meReadWaitMsOf(error);
            if (waitMs === null || attempt >= ME_READ_ATTEMPTS) throw error;
            const status = error instanceof OnlineProviderError ? error.httpStatus : undefined;
            noteLoginStatusCheck(diagnosticLine`GET /me answered ${status ?? 'an error'}: waiting ${waitMs}ms and asking again (${attempt} of ${ME_READ_ATTEMPTS - 1} retries)`);
            console.warn('[Spotify] reading the account was throttled; asking again', error);
            await sleep(waitMs);
            attempt += 1;
        }
    }
};

/*
 * 同时在问 `/me` 的只问一次。
 *
 * 登录确认之后「读账号」和别处的登录态检查常常是同一时刻问同一样东西，各自发一次就成了两三个
 * 一模一样的请求 —— 撞上限流的往往正是这种重复，而重复本身又不带来任何新信息。
 */
let pendingMe: Promise<any> | null = null;

const readMe = async (): Promise<any> => {
    if (pendingMe) return pendingMe;
    const request = askMe().finally(() => {
        if (pendingMe === request) pendingMe = null;
    });
    pendingMe = request;
    return request;
};

/**
 * 登录态下这个人是谁。
 *
 * ⚠️ 只有「平台说这个登录不算数」才等于没人登录。**其它错误一律抛出去**，不能吞成 null：
 * 返回 null 会让读账号那一步把账号直接清掉（"nobody is signed in"），于是网络抖一下
 * 就变成「刚登进去就被登出」，而真正的报错信息还被这一句 catch 吃掉了。
 *
 * ⚠️ 反过来，限流也不能当失败：确认之后那一次 `GET /me` 撞上 429 就把整次登录记成
 * account-refresh-failed，等于白登一次。所以「读」这一步自己在 readMe 里按 Retry-After
 * 重试几次 —— 只有重试用完还不行才真的抛出去。
 */
const readSignedInUser = async (): Promise<ProviderUser | null> => {
    if (!session) {
        noteLoginStatusCheck(diagnosticLine`no session is held: the sign-in left none`);
        return null;
    }
    let me: any;
    try {
        me = await readMe();
    } catch (error) {
        noteLoginStatusCheck(diagnosticLine`GET /me failed: ${messageOf(error)}`);
        console.warn('[Spotify] Could not read the signed-in account', error);
        if (error instanceof OnlineProviderError && error.code === 'auth-required') return null;
        throw error;
    }
    const nickname = String(me?.display_name ?? me?.id ?? '');
    if (!nickname) {
        noteLoginStatusCheck(diagnosticLine`GET /me named nobody: no display name and no id`);
        return null;
    }
    const user: ProviderUser = {
        id: String(me?.id ?? nickname),
        nickname,
        avatarUrl: me?.images?.[0]?.url ?? undefined,
    };
    noteLoginStatusCheck(diagnosticLine`signed in (id ${user.id ? 'present' : 'missing'}, nickname present)`);
    return user;
};

/** 登录诊断报告里 Spotify 那一段。 */
export const getSpotifyLoginDiagnostics = (): LoginDiagnosticLine[] => {
    const lines: LoginDiagnosticLine[] = [];
    if (!session) {
        lines.push(diagnosticLine`session: none`);
    } else {
        const leftMs = session.expiresAtMs - Date.now();
        lines.push(diagnosticLine`session: held, access token valid for ${Math.max(0, Math.round(leftMs / 1000))}s, refresh token ${session.refreshToken ? 'present' : 'missing'}`);
    }
    lines.push(diagnosticLine`native OAuth: ${isSpotifyNativeAvailable() ? 'available' : 'not available'}`);
    if (lastLoginStatusCheck) lines.push(lastLoginStatusCheck);
    return lines;
};

export const runSpotifyInPage = async (operation: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (operation === 'login_status') return readSignedInUser();
    if (operation === 'logout') {
        signOutSpotifyInPage();
        return {};
    }
    /*
     * 安卓上 OAuth 是原生 Activity + 本地端口**一次性走完**的，所以 `login_start` 就会等到
     * 出结果。折回桌面端那套「开始 → 轮询」的形状：成了给一个 key，随后 `login_check`
     * 立刻答 confirmed；没成就直接抛 —— 原因词原样带在 cause 上，
     * spotifyLoginFailure 靠它挑出该显示哪一句（'cannot-listen' / 'access-denied' / …）。
     */
    if (operation === 'login_start') {
        const result = await requestSpotifyNativeSignIn();
        if (!result.ok) {
            throw new OnlineProviderError(
                result.error.code === 'unavailable' ? 'unavailable' : 'auth-required',
                result.error.message,
                'spotify',
                result.error.code,
            );
        }
        const { accessToken, refreshToken, expiresInMs } = result.session;
        session = { accessToken, refreshToken, expiresAtMs: Date.now() + expiresInMs };
        return { key: `native-${Date.now()}`, expiresInMs: LOGIN_TTL_MS };
    }
    if (operation === 'login_check') return { state: session ? 'confirmed' : 'expired' };
    if (operation === 'login_open') return {};
    if (operation === 'login_cancel') return {};
    if (UNSUPPORTED.has(operation)) {
        throw new OnlineProviderError('unsupported', `Spotify ${operation} is not available on Android yet`, 'spotify');
    }

    const token = await ensureFreshToken();

    if (operation === 'library') {
        const page = await call(`/me/tracks?limit=${clampRows(params.limit)}&offset=${offsetOf(params.offset)}`, token);
        return likedAnswerOf(page);
    }

    if (operation === 'lyrics') {
        // 公开 Web API 根本不提供歌词（桌面端是 librespot 走私有端点拿的）。
        throw new OnlineProviderError('unsupported', 'Spotify lyrics are not in the public API', 'spotify');
    }

    if (operation !== 'query') {
        throw new OnlineProviderError('unsupported', `Spotify ${operation} is not available on Android yet`, 'spotify');
    }

    /*
     * 参数在 `variables` 里，不在顶层：`querySpotify(name, variables)` 发的是
     * `{ name, variables }`。早先这里在顶层找 `query`，于是搜索永远带空关键词。
     */
    const variables = (params.variables ?? {}) as Record<string, unknown>;
    const name = String(params.name ?? '');
    if (UNSUPPORTED_QUERIES.has(name)) {
        throw new OnlineProviderError('unsupported', `Spotify ${name} has no public equivalent`, 'spotify');
    }

    switch (name) {
        case 'searchTracks': {
            const term = String(variables.searchTerm ?? variables.query ?? '');
            const page = await call(
                `/search?q=${encodeURIComponent(term)}&type=track&limit=${clampRows(variables.limit)}&offset=${offsetOf(variables.offset)}`,
                token,
            );
            return {
                searchV2: {
                    tracksV2: {
                        items: ((page?.tracks?.items ?? []) as any[]).map(track => ({ item: { data: trackOf(track) } })),
                    },
                },
            };
        }
        case 'getTrack': {
            const track = await call(`/tracks/${idOf(variables.uri ?? variables.id)}`, token);
            const shaped = trackOf(track);
            /*
             * 艺术家必须放在 `firstArtist` 上：spotifyProvider 那边是用
             * `[...firstArtist, ...otherArtists]` 重拼 `artists` 的，只给 `artists`
             * 会被那一次覆盖抹成空 —— 表现为「歌曲在，歌手没了」。
             */
            return { trackUnion: { ...shaped, firstArtist: { items: shaped?.artists?.items ?? [] }, otherArtists: { items: [] } } };
        }
        case 'getAlbum': {
            const albumId = idOf(variables.uri ?? variables.id);
            // 表头与这一页曲目是两个接口：一次拿两样，省得每张专辑点进去都发两次。
            const [album, page] = await Promise.all([
                call(`/albums/${albumId}`, token),
                call(`/albums/${albumId}/tracks?limit=${clampRows(variables.limit)}&offset=${offsetOf(variables.offset)}`, token),
            ]);
            return {
                albumUnion: {
                    ...albumOf(album),
                    tracksV2: {
                        totalCount: Number(page?.total ?? 0) || 0,
                        items: ((page?.items ?? []) as any[]).map(track => ({ track: trackOf(track) })),
                    },
                },
            };
        }
        case 'fetchPlaylist': {
            const playlistId = idOf(variables.uri ?? variables.id);
            const [list, page] = await Promise.all([
                call(`/playlists/${playlistId}`, token),
                call(`/playlists/${playlistId}/tracks?limit=${clampRows(variables.limit)}&offset=${offsetOf(variables.offset)}`, token),
            ]);
            return {
                playlistV2: {
                    ...playlistOf(list),
                    content: {
                        totalCount: Number(page?.total ?? list?.tracks?.total ?? 0) || 0,
                        items: ((page?.items ?? []) as any[]).map(row => ({ itemV2: { data: trackOf(row?.track) } })),
                    },
                },
            };
        }
        case 'queryArtistOverview': {
            const artistId = idOf(variables.uri ?? variables.id);
            const [artist, top, albums] = await Promise.all([
                call(`/artists/${artistId}`, token),
                call(`/artists/${artistId}/top-tracks?market=from_token`, token),
                // 公开 API 不给「专辑数 / 单曲数」这两个分开的数，只有专辑那一页的总数。
                call(`/artists/${artistId}/albums?limit=1`, token),
            ]);
            return {
                artistUnion: {
                    ...artistOf(artist),
                    discography: {
                        topTracks: { items: ((top?.tracks ?? []) as any[]).map(track => ({ track: trackOf(track) })) },
                        albums: { totalCount: Number(albums?.total ?? 0) || 0 },
                        singles: { totalCount: 0 },
                    },
                },
            };
        }
        case 'queryArtistDiscographyAll': {
            const artistId = idOf(variables.uri ?? variables.id);
            const page = await call(
                `/artists/${artistId}/albums?include_groups=album,single,appears_on,compilation`
                    + `&limit=${clampRows(variables.limit)}&offset=${offsetOf(variables.offset)}`,
                token,
            );
            return {
                artistUnion: {
                    discography: {
                        all: {
                            totalCount: Number(page?.total ?? 0) || 0,
                            items: ((page?.items ?? []) as any[]).map(album => ({ releases: { items: [albumOf(album)] } })),
                        },
                    },
                },
            };
        }
        case 'libraryV3': {
            const filters = Array.isArray(variables.filters) ? variables.filters.map(String) : [String(variables.filters ?? '')];
            const wantsAlbums = filters.some(filter => filter.toLowerCase().includes('album'));
            const rows = `limit=${clampRows(variables.limit)}&offset=${offsetOf(variables.offset)}`;
            if (wantsAlbums) {
                const page = await call(`/me/albums?${rows}`, token);
                return {
                    me: {
                        libraryV3: {
                            totalCount: Number(page?.total ?? 0) || 0,
                            items: ((page?.items ?? []) as any[]).map(row => ({ item: { data: albumOf(row?.album) } })),
                        },
                    },
                };
            }
            const page = await call(`/me/playlists?${rows}`, token);
            return {
                me: {
                    libraryV3: {
                        totalCount: Number(page?.total ?? 0) || 0,
                        items: ((page?.items ?? []) as any[]).map(list => ({ item: { data: playlistOf(list) } })),
                    },
                },
            };
        }
        case 'fetchLibraryTracks': {
            const page = await call(`/me/tracks?limit=${clampRows(variables.limit)}&offset=${offsetOf(variables.offset)}`, token);
            return likedAnswerOf(page);
        }
        case 'areEntitiesInLibrary': {
            const uris = (Array.isArray(variables.uris) ? variables.uris : String(variables.uris ?? '').split(','))
                .map(String).filter(Boolean);
            /*
             * 顺序必须与问的 uris 一一对应：那边是按下标把结果配回每首歌的
             * （spotifyLibrary.areSongsLiked）。所以不能「先查曲目再查专辑」拼起来，
             * 得分头查完再按原顺序排回去。
             */
            const saved = new Map<string, boolean>();
            const trackIds = uris.filter(uri => uri.includes(':track:')).map(uri => spotifyId(uri, 'track')).filter(Boolean);
            const albumIds = uris.filter(uri => uri.includes(':album:')).map(uri => spotifyId(uri, 'album')).filter(Boolean);
            const [tracks, albums] = await Promise.all([
                trackIds.length ? call(`/me/tracks/contains?ids=${encodeURIComponent(trackIds.join(','))}`, token) : null,
                albumIds.length ? call(`/me/albums/contains?ids=${encodeURIComponent(albumIds.join(','))}`, token) : null,
            ]);
            (tracks as boolean[] | null)?.forEach((value, at) => { if (trackIds[at]) saved.set(`track:${trackIds[at]}`, value === true); });
            (albums as boolean[] | null)?.forEach((value, at) => { if (albumIds[at]) saved.set(`album:${albumIds[at]}`, value === true); });
            return {
                lookup: uris.map(uri => {
                    const kind = uri.includes(':album:') ? 'album' : 'track';
                    const id = kind === 'album' ? spotifyId(uri, 'album') : spotifyId(uri, 'track');
                    const value = saved.get(`${kind}:${id}`);
                    return { data: { saved: value === true } };
                }),
            };
        }
        default:
            throw new OnlineProviderError('unsupported', `Spotify query ${name} is not available on Android yet`, 'spotify');
    }
};

/** 「我喜欢的歌曲」那一页：桌面端装在 `me.library.tracks` 里。 */
const likedAnswerOf = (page: any): unknown => ({
    me: {
        library: {
            tracks: {
                totalCount: Number(page?.total ?? 0) || 0,
                items: ((page?.items ?? []) as any[]).map(row => ({ track: { _uri: String(row?.track?.uri ?? ''), data: trackOf(row?.track) } })),
            },
        },
    },
});

/** 取当前 token（给要拼 URL 的地方用）；没登录就是 null。 */
export const peekSpotifyAccessToken = (): string | null => session?.accessToken ?? null;
