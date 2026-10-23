import { OnlineProviderError } from '../../../types/onlineMusic';
import type { LoginDiagnosticLine, ProviderUser } from '../../../types/onlineMusic';
import { isCapacitorAndroid } from '../../../platform/runtime';
import { diagnosticLine, formatDiagnosticClock } from '../login/loginDiagnosticReport';
import { isNativeHttpFetchAvailable, createNativeFetch } from '../../../services/nativeHttpFetch';
import { requestYtmNativeSignIn, type YtmNativeSession } from './ytmNative';

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

const UNSUPPORTED = new Set(['audio', 'playlist_edit', 'list_save', 'list_saved', 'song_like', 'mix']);

/** 只建一次：Innertube 建起来要拉一次 innertube 的配置，重复建既慢又没必要。 */
let sessionPromise: Promise<unknown> | null = null;
let currentCookie: string | null = null;

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
    const { Innertube } = await import('youtubei.js/web');
    return Innertube.create({
        // 带着 cookie 建 = 已登录；不带就是匿名，公开接口照样通。
        ...(signedIn ? { cookie: signedIn.cookie, user_agent: signedIn.userAgent } : {}),
        // 播放器那一路要 poToken（BotGuard），安卓上搞不定，也不要 —— 这里只要取数。
        retrieve_player: false,
        /*
         * 关键是这个：WebView 里直连 youtube.com 会被同源检查掐掉，所以把请求交给我们
         * 自己的原生 OkHttp 桥（见 services/nativeHttpFetch）。youtubei.js 支持注入
         * fetch，官方给的浏览器用法也正是「自己实现一个 fetch 转发到代理」。
         */
        fetch: createNativeFetch(),
    });
};

const getSession = async (): Promise<any> => {
    if (!sessionPromise) sessionPromise = loadInnertube();
    return sessionPromise;
};

/** cookie 变了就要重建：登录 / 登出之后调用。 */
export const resetYtmInPageSession = (): void => {
    sessionPromise = null;
    currentCookie = null;
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
 * 最近一次「登录进去的是谁」的结论：登录确认之后账号没读出来（account-refresh-failed）
 * 时，诊断报告里 YouTube Music 这一段就靠它说出卡在哪。与另一家同一套写法。
 */
let lastLoginStatusCheck: LoginDiagnosticLine | null = null;
const noteLoginStatusCheck = (summary: LoginDiagnosticLine): void => {
    lastLoginStatusCheck = diagnosticLine`${formatDiagnosticClock(Date.now())} ${summary}`;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readSignedInUser = async (): Promise<ProviderUser | null> => {
    if (!signedIn) {
        noteLoginStatusCheck(diagnosticLine`no cookie is held: nobody signed in`);
        return null;
    }
    let info: any;
    try {
        const yt: any = await getSession();
        info = await yt.account.getInfo();
    } catch (error) {
        noteLoginStatusCheck(diagnosticLine`account.getInfo failed: ${messageOf(error)}`);
        console.warn('[Ytm] Could not read the signed-in account', error);
        /*
         * 与另一家同一条规矩：只有「平台说这个登录不算数」才等于没人登录，其它错误
         * 必须抛出去。一律吞成 null 会把一次网络抖动说成「你没登录」，账号当场被清掉。
         */
        if (error instanceof OnlineProviderError && error.code === 'auth-required') return null;
        throw error;
    }
    // 拿不到名字就老实说「不知道是谁」—— 返回一个编出来的空账号比不返回更糟。
    const name = String(info?.account_name ?? info?.channel_handle ?? '');
    if (!name) {
        noteLoginStatusCheck(diagnosticLine`account.getInfo named nobody: no account name and no channel handle`);
        return null;
    }
    const user: ProviderUser = {
        id: String(info?.channel_id ?? name),
        nickname: name,
        avatarUrl: info?.account_photo_url ?? undefined,
    };
    noteLoginStatusCheck(diagnosticLine`signed in (id ${user.id ? 'present' : 'missing'}, nickname present)`);
    return user;
};

/** 登录诊断报告里 YouTube Music 那一段。 */
export const getYtmLoginDiagnostics = (): LoginDiagnosticLine[] => {
    const lines: LoginDiagnosticLine[] = [];
    lines.push(diagnosticLine`cookie: ${signedIn ? 'held' : 'none'}`);
    lines.push(diagnosticLine`in-page transport: ${isYtmInPageAvailable() ? 'available' : 'not available'}`);
    if (lastLoginStatusCheck) lines.push(lastLoginStatusCheck);
    return lines;
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
    const text = (value: unknown) => String(value ?? '');

    switch (operation) {
        case 'search_songs': {
            const query = text(params.query ?? params.q);
            if (!query) throw new OnlineProviderError('invalid-response', 'A search needs a query', 'ytm');
            const results = await yt.music.search(query, { filter: 'songs' });
            return results;
        }
        case 'lyrics': {
            const id = text(params.videoId ?? params.id ?? params.browseId);
            if (!id) throw new OnlineProviderError('invalid-response', 'Lyrics need a video id', 'ytm');
            return yt.music.getLyrics(id);
        }
        case 'album':
            return yt.music.getAlbum(text(params.browseId ?? params.id));
        case 'artist':
            return yt.music.getArtist(text(params.browseId ?? params.id));
        case 'playlist':
        case 'public_playlist':
            return yt.music.getPlaylist(text(params.id ?? params.browseId ?? params.playlistId));
        case 'song_detail':
        case 'song_detail_en':
        case 'song_detail_zh':
            return yt.music.getInfo(text(params.videoId ?? params.id));
        case 'explore':
            return yt.music.getHomeFeed();
        case 'user_playlists':
        case 'user_albums':
            requireSignIn(operation);
            return yt.music.getLibrary();
        default:
            throw new OnlineProviderError('unsupported', `YouTube Music ${operation} is not available on Android yet`, 'ytm');
    }
};
