import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../../../platform/runtime';

// src/services/onlineMusic/ytm/ytmNative.ts
//
// YouTube Music 在安卓上唯一要用到原生的地方：一座登录 Activity（FoliaYtm）。
//
// 与汽水那条路**刻意不同**：协议层（youtubei.js）跑在主 WebView 里 —— 它本来就是浏览器库，
// 不该塞进一个隐藏 WebView。原生只剩「让人登录一次、把 YouTube 的 cookie 交出来」这件事，
// 所以这个文件里没有任何取数代码。
//
// 为什么放在 ytm 目录里而不是与别的原生插件挤在一起（src/platform/foliaNative.ts）：
// 它是这一家的规则，就该跟着这一家 —— 那一处每多提一次平台名，架构守卫就要记一笔。
//
// 为什么非得走原生：YouTube 没给 YouTube Music 的 OAuth，凭据只能是 cookie；而 cookie
// 只能从「用户真的登录过的那个 WebView」里读。主界面那个 WebView 直接导航到
// accounts.google.com 等于把整个应用页面换掉，Chrome Custom Tab 的 cookie 又落进 Chrome
// 自己的罐里 —— 所以单独开一座 Activity 装 WebView（android/…/YtmSignInActivity.java）。
//
// 没登录也**不意味着不可用**：搜索 / 专辑 / 歌单 / 歌词都是公开接口，匿名就能通 ——
// 「能不能用」与「能不能登录」在这一家是两件事（见 ytmInPageRuntime）。

export type YtmNativeSession = {
    /** 登录完成后从 CookieManager 取到的整条 Cookie 头。凭据本体：不落日志、不进错误。 */
    cookie: string;
    /** 取 cookie 那个 WebView 的 UA。YouTube 会按 UA 决定给不给某些接口，必须与 cookie 同源。 */
    userAgent: string;
};

export type YtmSignInResult =
    | { ok: true; session: YtmNativeSession }
    | { ok: false; error: { code: string; message: string } };

interface FoliaYtmPlugin {
    /** 起登录 Activity，等用户登录完（或取消）后带回 cookie。 */
    signIn(): Promise<YtmSignInResult>;
    status(): Promise<{ ready: boolean; reason?: string }>;
}

const FoliaYtm = registerPlugin<FoliaYtmPlugin>('FoliaYtm');

/**
 * 安卓上 YTM 那座登录 Activity 在不在。
 *
 * ⚠️ 这里必须用 `Capacitor.isPluginAvailable`，**不能**写
 * `typeof FoliaYtm?.signIn === 'function'`：`registerPlugin` 给回来的是个代理，任何
 * 方法名问过去都是 function，于是原生侧根本没实现时这一句也返回 true —— 表现为
 * 「还没登录就显示有账号、点退出登录报未知错误」（真出过一次）。
 * `isPluginAvailable` 查的是原生侧上报的 pluginHeaders，没注册就是 false。
 */
export const isYtmNativeAvailable = (): boolean => (
    isCapacitorAndroid() && Capacitor.isPluginAvailable('FoliaYtm')
);

/** 让用户登录 YouTube 并把 cookie 交回来。取消 / 超时都是 ok:false，不是抛错。 */
export const requestYtmNativeSignIn = async (): Promise<YtmSignInResult> => {
    if (!isYtmNativeAvailable()) {
        return { ok: false, error: { code: 'unavailable', message: 'YTM sign-in is not available here' } };
    }
    try {
        const result = await FoliaYtm.signIn();
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: false, error: { code: 'invalid-response', message: 'YTM sign-in returned a malformed result' } };
    } catch (error) {
        return { ok: false, error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
};
