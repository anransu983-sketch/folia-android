import { OnlineProviderError } from '../../../types/onlineMusic';
import type { LoginDiagnosticLine, ProviderUser } from '../../../types/onlineMusic';
import { isCapacitorAndroid } from '../../../platform/runtime';
import { diagnosticLine, formatDiagnosticClock } from '../login/loginDiagnosticReport';
import { isNativeHttpFetchAvailable, createNativeFetch } from '../../../services/nativeHttpFetch';
import { requestYtmNativeSignIn, type YtmNativeSession } from './ytmNative';
import { accountFromYtmAccountsList, ytmSignedInMarkOf } from './ytmAccountsList';
import { ytmHomepageSignedInOf } from './ytmHomepage';
import {
    YTM_VIDEO_ID, ytmAlbumFromCard, ytmAlbumFromPage, ytmArtistFromPage, ytmCollectionFromRow,
    ytmExploreSectionsOf, ytmLrcFromLyricsPage, ytmLyricsBrowseId, ytmPlaylistCountOf,
    ytmPlaylistPageOf, ytmPlaylistRowsOf, ytmReadGrid, ytmSongFromListItem, ytmSongFromQueueItem,
    ytmSongOfWatchPage,
} from './ytmInPageCatalog';
import type { YtmWireCollection, YtmWireSong } from './ytmTransport';

/**
 * 安卓 WebView 里这套页内协议层能不能用。
 *
 * 它**不需要为它新写原生**：youtubei.js 是浏览器库，跑在主 WebView 里，搜索 / 专辑 /
 * 歌单 / 歌词匿名就能通。原生（FoliaYtm 那座登录 Activity）只在「要用户自己的歌单」
 * 时才需要，所以没登录不等于不可用 —— 这与「每一步都要 token」的那一家是两回事。
 *
 * 但**有一条原生依赖**：WebView 里的页面是有来源的（https://localhost），直连
 * youtube.com 会被同源检查掐掉（youtubei.js 的文档也明写「浏览器里必须走自己的代理」）。
 * 所以这里要求原生 OkHttp 桥在场，并由它充当 youtubei.js 的 fetch —— 见 loadInnertube。
 */
export const isYtmInPageAvailable = (): boolean => isCapacitorAndroid() && isNativeHttpFetchAvailable();

// src/services/onlineMusic/ytm/ytmInPageRuntime.ts
//
// 安卓上的 YouTube Music 协议层：跑在**主 WebView 里**，用 youtubei.js —— 它本来就是浏览器
// 库，所以不需要原生替它开一个隐藏 WebView（那是汽水那条路的形状，这里刻意不走）。
//
// 原生只剩一座登录 Activity：YouTube 没给 YouTube Music 的 OAuth，凭据只能是 cookie，
// 而 cookie 只能从「用户真的登录过的那个 WebView」里读 —— 见 platform/foliaNative 的 FoliaYtm。
//
// 没有登录也能用大半：搜索、专辑、歌单、歌词都是公开接口。要用户自己的歌单才需要 cookie。

const UNSUPPORTED = new Set(['audio', 'playlist_edit', 'list_save', 'list_saved', 'song_like']);

/** 只建一次：Innertube 建起来要拉一次 innertube 的配置，重复建既慢又没必要。 */
let sessionPromise: Promise<unknown> | null = null;
let currentCookie: string | null = null;

/** 与 Innertube 同一次加载拿到的解析器、节点类型表与客户端常量（歌单页/观看页/按语言读歌名要用）。 */
let parserLib: any = null;
let nodesLib: any = null;
let constantsLib: any = null;

/** 登录拿到的 cookie（内存里，不落盘 —— 它就是这个账号）。 */
let signedIn: YtmNativeSession | null = null;

const loadInnertube = async () => {
    /*
     * 用 `/web` 这个入口：youtubei.js 的主入口带 Node 侧的东西，浏览器/WebView 要的是
     * 它单独打出来的这一份（官方 README 的 Browser Usage 就是这么 import 的）。
     *
     * 动态 import 是刻意的：整个库不小，而它只在这台设备真是安卓、且用户真的碰了
     * YouTube Music 时才用得上 —— 走异步分包，别让它进主包。
     */
    const lib: any = await import('youtubei.js/web');
    parserLib = lib.Parser;
    nodesLib = lib.YTNodes;
    constantsLib = lib.Constants;
    return lib.Innertube.create({
        // 带着 cookie 建 = 已登录；不带就是匿名，公开接口照样通。
        ...(signedIn ? { cookie: signedIn.cookie, user_agent: signedIn.userAgent } : {}),
        // 播放器那一路要 poToken（BotGuard），安卓上搞不定，也不要 —— 这里只要取数。
        retrieve_player: false,
        /*
         * 关键是这个：WebView 里直连 youtube.com 会被同源检查掐掉，所以把请求交给我们
         * 自己的原生 OkHttp 桥（见 services/nativeHttpFetch）。youtubei.js 支持注入
         * fetch，官方给的浏览器用法也正是「自己实现一个 fetch 转发到代理」。
         */
        fetch: createYtmApiFetch(),
    });
};

/*
 * 给 youtubei.js 的请求补上它在 WebView 里缺的那个 Origin 头。
 *
 * youtubei.js 的 HTTPClient 只在「服务端」那一份（Platform.shim.server）里才给
 * 接口请求设 Origin，WebView 里跑的是浏览器那一份，这头就缺了。可它算登录签名
 * SAPISIDHASH 时用的来源是写死的 https://www.youtube.com —— 签名里带着来源、
 * 请求里却没有，服务端无从核对就按游客答（真机实证：cookie 明明是真登录、
 * 用户在登录窗里看到了自己的头像，接口两路却都判游客）。桌面端跑的是主进程那
 * 一份、Origin 一直在场，所以同一把库、同一套 cookie 在那边是通的。
 * 这里在我们自己的 fetch 层把头补齐：只补 youtubei 接口、只在头还不在时补，
 * 值与签名用的来源用同一个常量，两边永远对得上。
 */
const YTM_API_ORIGIN = 'https://www.youtube.com';

const createYtmApiFetch = (): typeof fetch => {
    const base = createNativeFetch();
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        let isApiCall = false;
        try {
            const target = new URL(rawUrl);
            isApiCall = (target.hostname === 'youtubei.googleapis.com' || target.hostname.endsWith('youtube.com'))
                && target.pathname.includes('/youtubei/');
        } catch {
            isApiCall = false;
        }
        if (!isApiCall) return base(input, init);
        const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
        if (!headers.has('origin')) headers.set('origin', YTM_API_ORIGIN);
        return base(input, { ...init, headers });
    }) as typeof fetch;
};

const getSession = async (): Promise<any> => {
    if (!sessionPromise) sessionPromise = loadInnertube();
    return sessionPromise;
};

/** cookie 变了就要重建：登录 / 登出之后调用。 */
export const resetYtmInPageSession = (): void => {
    sessionPromise = null;
    currentCookie = null;
    // 发现页的 feed 链是上一个会话读的，一并作废（声明在下面，调用时早已就绪）。
    homeFeedChain = null;
};

/** 让用户登录 YouTube，并把 cookie 记住。返回是否拿到了会话。 */
export const signInYtmInPage = async (): Promise<boolean> => {
    const result = await requestYtmNativeSignIn();
    if (!result.ok) throw new OnlineProviderError('auth-required', result.error.message, 'ytm', result.error.code);
    signedIn = result.session;
    resetYtmInPageSession();
    return true;
};

export const signOutYtmInPage = (): void => {
    signedIn = null;
    resetYtmInPageSession();
};

export const isSignedInYtmInPage = (): boolean => signedIn !== null;

/** 需要一个登录态的 operation：没登录就明说，别返回空列表让人以为「真的没有」。 */
const requireSignIn = (operation: string) => {
    if (signedIn) return;
    throw new OnlineProviderError('auth-required', `YouTube Music sign-in is needed for ${operation}`, 'ytm');
};

/*
 * `login_status` 的返回形状是 wire 契约的一部分，**不能自创**：
 * ytmProvider 那边写的是 `requestYtm<ProviderUser | null>('login_status')`，
 * 也就是「没登录必须是 null」。早先这里返回 `{ signedIn: false }` —— 那是个真值对象，
 * 于是被当成「有一个账号」，凭空多出一个空账号（真出过一次）。
 * 契约见 src/types/onlineMusic.ts 的 ProviderUser：id / nickname / avatarUrl? / vipType?。
 */
/*
 * 最近一次「登录进去的是谁」的核查记录：一轮核查有好几个信号（getInfo、
 * accounts_list、首页），结论可能互相矛盾，诊断报告要能逐条对着看，所以记一组
 * 而不是只留最后一句。登录确认之后账号没读出来（account-refresh-failed）时，
 * 报告里 YouTube Music 这一段就靠它说出卡在哪。
 */
let loginStatusCheckLines: LoginDiagnosticLine[] = [];
const noteLoginStatusCheck = (summary: LoginDiagnosticLine): void => {
    loginStatusCheckLines = [...loginStatusCheckLines, diagnosticLine`${formatDiagnosticClock(Date.now())} ${summary}`].slice(-8);
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readSignedInUser = async (): Promise<ProviderUser | null> => {
    // 每查一次是一组新的行：上一轮的结论别混进这一轮的报告。
    loginStatusCheckLines = [];
    if (!signedIn) {
        noteLoginStatusCheck(diagnosticLine`no cookie is held: nobody signed in`);
        return null;
    }
    const yt: any = await getSession();
    let getInfoError: unknown = null;
    try {
        const info: any = await yt.account.getInfo();
        const name = String(info?.account_name ?? info?.channel_handle ?? '');
        if (name) {
            const user: ProviderUser = {
                id: String(info?.channel_id ?? name),
                nickname: name,
                avatarUrl: info?.account_photo_url ?? undefined,
            };
            noteLoginStatusCheck(diagnosticLine`signed in (id ${user.id ? 'present' : 'missing'}, nickname present)`);
            return user;
        }
        noteLoginStatusCheck(diagnosticLine`account.getInfo named nobody: no account name and no channel handle`);
    } catch (error) {
        getInfoError = error;
        noteLoginStatusCheck(diagnosticLine`account.getInfo failed: ${messageOf(error)}`);
        console.warn('[Ytm] Could not read the signed-in account', error);
        /*
         * 与另一家同一条规矩：只有「平台说这个登录不算数」才等于没人登录，其它错误
         * 必须抛出去。一律吞成 null 会把一次网络抖动说成「你没登录」，账号当场被清掉。
         */
        if (error instanceof OnlineProviderError && error.code === 'auth-required') return null;
    }
    /*
     * 走到这里有两种情形：getInfo 抛了错（它的解析与平台现在的答复对不上时必抛一个
     * 没头没脑的 'Page contents not found'，真机上必现），或者它读到了却没读出名字。
     * 这都不等于没登录 —— 再往下走备用信号（见 readUserFromFallbackProbes）。
     */
    return readUserFromFallbackProbes(yt, getInfoError);
};

type AccountsListProbe =
    | { verdict: 'signed-in'; user: ProviderUser }
    | { verdict: 'guest' | 'unknown'; error: unknown };

/** 备用信号一：accounts_list 的原始答复说登录了没有、是谁（判据见 ytmAccountsList）。 */
const probeAccountsList = async (yt: any): Promise<AccountsListProbe> => {
    let data: unknown;
    try {
        const response: any = await yt.actions.execute('/account/accounts_list', { client: 'YTMUSIC', parse: false });
        data = response?.data;
    } catch (error) {
        noteLoginStatusCheck(diagnosticLine`accounts_list check failed: ${messageOf(error)}`);
        console.warn('[Ytm] Could not read the accounts list', error);
        return { verdict: 'unknown', error };
    }
    const mark = ytmSignedInMarkOf(data);
    if (mark === '1') {
        const account = accountFromYtmAccountsList(data);
        const user: ProviderUser = {
            id: account?.id || 'ytm',
            nickname: account?.nickname || 'YouTube Music',
            avatarUrl: account?.avatarUrl,
        };
        noteLoginStatusCheck(diagnosticLine`accounts_list confirmed the sign-in (logged_in=1, name ${account?.nickname ? 'present' : 'absent'})`);
        return { verdict: 'signed-in', user };
    }
    if (mark === '0') {
        // 只是这一路的结论：这次接口请求是按游客答的。它先记下来，不再一票否决。
        noteLoginStatusCheck(diagnosticLine`accounts_list answered as a guest (logged_in=0)`);
        return { verdict: 'guest', error: null };
    }
    noteLoginStatusCheck(diagnosticLine`accounts_list carried no logged_in mark: cannot tell who is signed in`);
    return { verdict: 'unknown', error: null };
};

/**
 * 备用信号二（铁证）：带着交回的 cookie 打开 music.youtube.com 首页，读页面自己
 * 写的登录结论（判据见 ytmHomepage）。这一路不靠接口签名 —— 接口那两路被签名
 * 认不下连累时，它读到的是与用户在登录窗里看到的头像同一份事实。
 */
const probeHomepage = async (): Promise<'signed-in' | 'guest' | 'unknown'> => {
    if (!signedIn) return 'unknown';
    try {
        const response = await createNativeFetch()('https://music.youtube.com/', {
            headers: { cookie: signedIn.cookie, 'user-agent': signedIn.userAgent },
        });
        if (!response.ok) {
            noteLoginStatusCheck(diagnosticLine`homepage check answered HTTP ${response.status}: cannot tell`);
            return 'unknown';
        }
        const mark = ytmHomepageSignedInOf(await response.text());
        if (mark === true) {
            noteLoginStatusCheck(diagnosticLine`homepage says signed in (its own LOGGED_IN flag is true)`);
            return 'signed-in';
        }
        if (mark === false) {
            noteLoginStatusCheck(diagnosticLine`homepage says guest (its own LOGGED_IN flag is false)`);
            return 'guest';
        }
        noteLoginStatusCheck(diagnosticLine`homepage carried no LOGGED_IN flag: cannot tell`);
        return 'unknown';
    } catch (error) {
        noteLoginStatusCheck(diagnosticLine`homepage check failed: ${messageOf(error)}`);
        return 'unknown';
    }
};

/*
 * 备用信号的合并判定：**任一可信信号确认登录即通过**。
 *
 * 为什么不再让 accounts_list 一票否决：它和 getInfo 走的是同一条接口签名路，
 * 签名没被认下时两路会一起说「游客」，而 cookie 本身是真的（真机实证：用户在
 * 登录窗里登完、关窗前是自己的头像，两路仍判游客）。首页那一路不靠签名，它说
 * 登录了，就不许接口那路把人否掉；它说游客、且没有任何一路说登录，才是真没登。
 * 三路都说不清时维持原判：先前那条的错抛出去（它离用户碰到的现象更近），不编。
 */
const readUserFromFallbackProbes = async (yt: any, getInfoError: unknown): Promise<ProviderUser | null> => {
    const list = await probeAccountsList(yt);
    if (list.verdict === 'signed-in') return list.user;
    const homepage = await probeHomepage();
    if (homepage === 'signed-in') {
        // 首页是铁证：登录成立。只是账号名这一路读不到，称呼退到平台名、id 退到
        // 平台 id（与 accounts_list 读到登录却没名字时的退法一致），不假装读到了。
        noteLoginStatusCheck(diagnosticLine`homepage overrules accounts_list (${list.verdict}): signed in, name unavailable from this signal`);
        return { id: 'ytm', nickname: 'YouTube Music' };
    }
    if (homepage === 'guest') return null;
    if (list.verdict === 'guest') return null;
    if (getInfoError) throw getInfoError;
    if (list.error) throw list.error;
    return null;
};

/** 登录诊断报告里 YouTube Music 那一段。 */
export const getYtmLoginDiagnostics = (): LoginDiagnosticLine[] => {
    const lines: LoginDiagnosticLine[] = [];
    lines.push(diagnosticLine`cookie: ${signedIn ? 'held' : 'none'}`);
    if (signedIn) {
        /*
         * 交回的 cookie 里有哪些键：**只列名字、绝不列值**。下次真机报告要能直接
         * 看出关键的那几颗（SAPISID、__Secure-3PSID、LOGIN_INFO 等）在不在交回的
         * 这串里 —— 在，断点就在校验/签名那一层；不在，断点回到原生收割那一层。
         */
        const names = [...new Set(signedIn.cookie.split(';').map((pair) => pair.split('=')[0]?.trim()).filter((name) => !!name))];
        lines.push(diagnosticLine`cookie keys: ${names.join(', ')}`);
    }
    lines.push(diagnosticLine`in-page transport: ${isYtmInPageAvailable() ? 'available' : 'not available'}`);
    lines.push(...loginStatusCheckLines);
    return lines;
};

/*
 * 数据类 operation 的回答形状同样是 wire 契约：桌面端 electron/ytm/ytmApiBridge.cjs
 * 从不把 youtubei.js 的原始答复直接交出去 —— 每个 operation 都先经 catalog.cjs /
 * webPages.cjs / webExplore.cjs 读成 `{ items, continuation? }` 一类形状，provider 只认
 * 那些形状。页内早先把库的答复原样返回（search 还把参数写成 { filter: 'songs' }，
 * 桌面是 { type: 'song' }），provider 在答复上读不到 items，搜索于是恒空（0.7.22.5
 * 真机实证）。下面每个 operation 都照桌面端的读法走 ytmInPageCatalog，两边形状一致。
 */

// 与桌面端同一套入参护栏（ytmApiBridge.cjs 的 boundedText / entityId）。
const boundedToken = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
        throw new OnlineProviderError('invalid-response', 'Invalid page token', 'ytm');
    }
    return value;
};
const entityIdOf = (value: unknown): string | null => (
    typeof value === 'string' && /^[\w-]{2,128}$/.test(value) ? value : null
);
const videoIdOf = (value: unknown): string | null => (
    typeof value === 'string' && YTM_VIDEO_ID.test(value) ? value : null
);

// 歌词带行时间只有手机端客户端的答复有（与桌面端同一条，见 ytmApiBridge.cjs）。
const MOBILE_BROWSE_URL = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false';
const WATCH_URL = 'https://music.youtube.com/youtubei/v1/next?prettyPrint=false';
const MOBILE_CLIENT = Object.freeze({ clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50' });
const PLAYLISTS_TAB = 'FEmusic_liked_playlists';
const ALBUMS_TAB = 'FEmusic_liked_albums';

/** 以某个语言读一首歌的观看页（桌面端 songInLanguage）：会话只有一个语言，所以请求里自己写明。 */
const songInLanguage = async (id: string, hl: string): Promise<YtmWireSong | null> => {
    const client = constantsLib?.CLIENTS?.YTMUSIC;
    if (!client?.NAME || !client?.VERSION || !parserLib) {
        throw new OnlineProviderError('unavailable', 'YouTube Music song details are unavailable', 'ytm');
    }
    const response = await createNativeFetch()(WATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: { clientName: client.NAME, clientVersion: client.VERSION, hl } }, videoId: id }),
    });
    if (!response.ok) throw new OnlineProviderError('unavailable', 'YouTube Music song details are unavailable', 'ytm');
    return ytmSongOfWatchPage(parserLib.parseResponse(await response.json()), id, nodesLib);
};

/**
 * 发现页在页内只有首页 feed 一条链：feed 对象不跨请求序列化，所以链留在这里，
 * 交出去的令牌是这条链的序号；序号对不上的令牌是上一次读的，按「没有更多」答。
 * （桌面端在 feed 之后还接 explore / charts 两页并去掉重架子，页内没有那套原始
 * 网页客户端，这部分差异记在案：形状一致，内容只到首页 feed。）
 */
let homeFeedChain: { feed: any; serial: number } | null = null;
let homeFeedSerial = 0;
const HOME_FEED_TOKEN = /^homefeed-(\d+)$/;

const exploreInPage = async (continuation: string | undefined): Promise<unknown> => {
    const yt: any = await getSession();
    if (continuation === undefined) {
        const feed = await yt.music.getHomeFeed();
        homeFeedSerial += 1;
        homeFeedChain = { feed, serial: homeFeedSerial };
        return {
            sections: ytmExploreSectionsOf(feed),
            ...(feed?.has_continuation ? { continuation: `homefeed-${homeFeedSerial}` } : {}),
        };
    }
    const serial = Number(HOME_FEED_TOKEN.exec(continuation)?.[1]);
    if (!homeFeedChain || homeFeedChain.serial !== serial) return { sections: [] };
    const feed = await homeFeedChain.feed.getContinuation();
    homeFeedChain = { feed, serial };
    return {
        sections: ytmExploreSectionsOf(feed),
        ...(feed?.has_continuation ? { continuation } : {}),
    };
};

/** 资料库的一个标签页（桌面端 webLibraryPage）：原始 browse 答复读成卡片，只留所问的那一类。 */
const libraryTabInPage = async (tabId: string, type: YtmWireCollection['type'], continuation: string | undefined): Promise<unknown> => {
    const yt: any = await getSession();
    const response: any = await yt.actions.execute('/browse', {
        ...(continuation ? { continuation } : { browseId: tabId }),
        client: 'YTMUSIC', parse: false,
    });
    const data = response?.data;
    if (ytmSignedInMarkOf(data) === '0') {
        throw new OnlineProviderError('auth-required', 'YouTube Music answered as to a guest', 'ytm');
    }
    const grid = ytmReadGrid(data);
    const items = grid.rows.map(row => ytmCollectionFromRow(row)).filter(item => item?.type === type);
    return { items, ...(grid.continuation ? { continuation: grid.continuation } : {}) };
};

/*
 * 登录这几步的回答形状也是 wire 契约的一部分：桌面端那套「浏览器里登录、轮询确认」的
 * 流程是 `web_login_*` 四个 operation 加各自的回答（见 ytmTransport 的
 * YtmWireWebLoginState），ytmProvider.auth 按它推进。
 *
 * 安卓上登录是原生 Activity 里**一次性做完**的（`web_login_start` 就 await 到底），
 * 所以这里把结果折回同一套状态：确认到账号就 confirmed，没有就 expired。
 * 不折的话 `answer.state` 是 undefined —— 既不是 error 也不是 confirmed，
 * 界面就一直转、永远收不到「登录成功」。
 */
export const runYtmInPage = async (operation: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (operation === 'login_status') return readSignedInUser();
    if (operation === 'logout') {
        signOutYtmInPage();
        return {};
    }
    if (operation === 'web_login_start') {
        await signInYtmInPage();
        return {};
    }
    if (operation === 'web_login_check') {
        const user = await readSignedInUser();
        return user ? { state: 'confirmed', account: user } : { state: 'expired' };
    }
    // 安卓上登录窗口由 start 那一步自己开出来，这两个只是把状态交回去。
    if (operation === 'web_login_open') return {};
    if (operation === 'web_login_cancel') return {};
    if (UNSUPPORTED.has(operation)) {
        throw new OnlineProviderError('unsupported', `YouTube Music ${operation} is not available on Android yet`, 'ytm');
    }

    const yt: any = await getSession();

    try {
        switch (operation) {
            case 'search_songs': {
                const continuation = boundedToken(params.continuation);
                if (continuation !== undefined) {
                    const page: any = await yt.actions.execute('/search', { continuation, client: 'YTMUSIC', parse: true });
                    const shelf = page.continuation_contents;
                    const items = (Array.isArray(shelf?.contents) ? shelf.contents : [])
                        .map((item: any) => ytmSongFromListItem(item)).filter((song: YtmWireSong | null): song is YtmWireSong => song !== null);
                    return { items, ...(typeof shelf?.continuation === 'string' && shelf.continuation ? { continuation: shelf.continuation } : {}) };
                }
                const query = typeof params.query === 'string' ? params.query.trim() : '';
                if (!query || query.length > 200) throw new OnlineProviderError('invalid-response', 'Search query is missing', 'ytm');
                const search: any = await yt.music.search(query, { type: 'song' });
                const shelf = (search.contents ?? []).find((section: any) => section?.type === 'MusicShelf');
                const items = (shelf?.contents ?? [])
                    .map((item: any) => ytmSongFromListItem(item)).filter((song: YtmWireSong | null): song is YtmWireSong => song !== null);
                return { items, ...(typeof shelf?.continuation === 'string' && shelf.continuation ? { continuation: shelf.continuation } : {}) };
            }
            case 'lyrics': {
                const id = videoIdOf(params.id);
                if (!id) throw new OnlineProviderError('invalid-response', 'Invalid track id', 'ytm');
                const watch: any = await yt.actions.execute('/next', { videoId: id, client: 'YTMUSIC', parse: false });
                const browseId = ytmLyricsBrowseId(watch?.data);
                if (!browseId) return null;
                const response = await createNativeFetch()(MOBILE_BROWSE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ context: { client: MOBILE_CLIENT }, browseId }),
                });
                if (!response.ok) throw new OnlineProviderError('unavailable', 'YouTube Music lyrics are unavailable', 'ytm');
                const mainText = ytmLrcFromLyricsPage(await response.json());
                return mainText ? { mainText } : null;
            }
            case 'album': {
                const id = entityIdOf(params.id);
                if (!id?.startsWith('MPRE')) throw new OnlineProviderError('invalid-response', 'Invalid album id', 'ytm');
                return ytmAlbumFromPage(await yt.music.getAlbum(id), id);
            }
            case 'artist': {
                const id = entityIdOf(params.id);
                if (!id?.startsWith('UC')) throw new OnlineProviderError('invalid-response', 'Invalid artist id', 'ytm');
                const { albumShelves, ...artist } = ytmArtistFromPage(await yt.music.getArtist(id), id);
                const self: Array<{ id: string; name: string }> = [{ id, name: artist.collection.name }];
                // 与桌面端一样：轮播只给头几张，「更多」页才列全；读不到就用轮播里的。
                const shelves = await Promise.all(albumShelves.map(async shelf => {
                    if (!shelf.more) return shelf.items;
                    try {
                        const page: any = await shelf.more.call(yt.actions, { client: 'YTMUSIC', parse: true });
                        const full = (page.contents_memo?.getType(nodesLib.MusicTwoRowItem) ?? [])
                            .map((item: any) => ytmAlbumFromCard(item, self)).filter((card: YtmWireCollection | null): card is YtmWireCollection => card !== null);
                        return full.length > 0 ? full : shelf.items;
                    } catch { return shelf.items; }
                }));
                const albums = [...new Map(shelves.flat().map(album => [album.id, album])).values()];
                return { ...artist, albums };
            }
            case 'playlist': {
                // 歌单按账号读（只有这样能看到私有的）：没登录就明说，别返回空列表。
                requireSignIn(operation);
                const id = entityIdOf(params.id);
                if (!id) throw new OnlineProviderError('invalid-response', 'Invalid playlist id', 'ytm');
                const continuation = boundedToken(params.continuation);
                const response: any = await yt.actions.execute('/browse', {
                    ...(continuation ? { continuation } : { browseId: `VL${id}` }),
                    client: 'YTMUSIC', parse: false,
                });
                const data = response?.data;
                if (ytmSignedInMarkOf(data) === '0') {
                    throw new OnlineProviderError('auth-required', 'YouTube Music answered as to a guest', 'ytm');
                }
                const trackCount = continuation ? undefined : ytmPlaylistCountOf(data);
                const read = ytmPlaylistPageOf(parserLib.parseResponse(data), Boolean(continuation), nodesLib, ytmPlaylistRowsOf(data), trackCount);
                if (continuation) return read;
                console.log(`[Ytm] Playlist page: ${read.items.length} song(s), ${read.items.filter(song => song.setVideoId).length} with the id of their row`);
                return trackCount === undefined ? read : { ...read, trackCount };
            }
            case 'public_playlist': {
                const id = entityIdOf(params.id);
                if (!id) throw new OnlineProviderError('invalid-response', 'Invalid playlist id', 'ytm');
                const continuation = boundedToken(params.continuation);
                const page: any = await yt.actions.execute('/browse', {
                    ...(continuation ? { continuation } : { browseId: `VL${id}` }),
                    client: 'YTMUSIC', parse: true,
                });
                return ytmPlaylistPageOf(page, Boolean(continuation), nodesLib);
            }
            case 'song_detail': {
                const id = videoIdOf(params.id);
                if (!id) throw new OnlineProviderError('invalid-response', 'Invalid track id', 'ytm');
                const page: any = await yt.actions.execute('/next', { videoId: id, client: 'YTMUSIC', parse: true });
                return ytmSongOfWatchPage(page, id, nodesLib);
            }
            case 'song_detail_en':
            case 'song_detail_zh': {
                const id = videoIdOf(params.id);
                if (!id) throw new OnlineProviderError('invalid-response', 'Invalid track id', 'ytm');
                return songInLanguage(id, operation === 'song_detail_en' ? 'en' : 'zh-CN');
            }
            case 'explore':
                return exploreInPage(boundedToken(params.continuation));
            case 'mix': {
                const id = entityIdOf(params.id);
                if (!id) throw new OnlineProviderError('invalid-response', 'Invalid mix id', 'ytm');
                const videoId = params.videoId === undefined ? undefined : videoIdOf(params.videoId);
                if (params.videoId !== undefined && !videoId) throw new OnlineProviderError('invalid-response', 'Invalid track id', 'ytm');
                const page: any = await yt.actions.execute('/next', {
                    playlistId: id, ...(videoId ? { videoId } : {}), client: 'YTMUSIC', parse: true,
                });
                const entries = page.contents_memo?.getType(nodesLib.PlaylistPanelVideo) ?? [];
                const items = entries.map((entry: any) => ytmSongFromQueueItem(entry)).filter((song: YtmWireSong | null): song is YtmWireSong => song !== null);
                console.log(`[Ytm] Mix ${id}: ${items.length} song(s)`);
                return { items };
            }
            case 'user_playlists':
                requireSignIn(operation);
                return libraryTabInPage(PLAYLISTS_TAB, 'playlist', boundedToken(params.continuation));
            case 'user_albums':
                requireSignIn(operation);
                return libraryTabInPage(ALBUMS_TAB, 'album', boundedToken(params.continuation));
            default:
                throw new OnlineProviderError('unsupported', `YouTube Music ${operation} is not available on Android yet`, 'ytm');
        }
    } catch (error) {
        // 与桌面端桥同一条：数据类 operation 失败要留痕，别被上层吞成一张空页还没人知道为什么。
        console.warn(`[Ytm] ${operation} failed`, error);
        throw error;
    }
};
