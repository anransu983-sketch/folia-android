import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../../../platform/runtime';

// src/services/onlineMusic/spotify/spotifyNative.ts
//
// Spotify 在安卓上唯一要用到原生的地方：OAuth（FoliaSpotify）。
//
// 两件 WebView 做不了的事：
//
//  · **收 OAuth 回调** —— 桌面端是在 Node 里起 `http://127.0.0.1:5588` 等 Spotify 把浏览器
//    送回来（见 electron/spotify/signIn.cjs）。安卓 WebView 起不了服务器，所以由 Java 起。
//    **端口保持 5588**：那个 client_id 量过的就是 5588，换端口 Spotify 未必认，而这个
//    client_id 不是我们的、白名单改不了。
//  · **换 token** —— `accounts.spotify.com/api/token` 从 WebView 里调会撞 CORS。
//
// 拿到 access token 之后，取数据（搜索 / 歌单 / 专辑）走公开 Web API，在主 WebView 里
// 直接 fetch，不再经过原生 —— 所以这里**没有任何取数代码**（见 spotifyInPageRuntime）。
//
// 为什么放在 spotify 目录里而不是与别的原生插件挤在一起（src/platform/foliaNative.ts）：
// 它是这一家的规则，就该跟着这一家 —— 那一处每多提一次平台名，架构守卫就要记一笔。

export type SpotifyNativeSession = {
    accessToken: string;
    refreshToken: string;
    /** 从拿到那一刻起算的有效期。 */
    expiresInMs: number;
};

export type SpotifySignInResult =
    | { ok: true; session: SpotifyNativeSession }
    | { ok: false; error: { code: string; message: string } };

interface FoliaSpotifyPlugin {
    /** 开浏览器去 Spotify 同意页，回调落到本进程的 5588，换完 token 返回。 */
    signIn(): Promise<SpotifySignInResult>;
    /** 用 refresh token 换一对新的。 */
    refresh(options: { refreshToken: string }): Promise<SpotifySignInResult>;
    status(): Promise<{ ready: boolean; reason?: string }>;
}

const FoliaSpotify = registerPlugin<FoliaSpotifyPlugin>('FoliaSpotify');

/**
 * 安卓上 Spotify 的登录插件在不在。
 *
 * ⚠️ 不能写成 `typeof FoliaSpotify?.signIn === 'function'`：`registerPlugin` 给回来的是个
 * **代理**，任何方法名问过去都是 function，原生侧一行没写时这一句也返回 true —— 表现为
 * 「还没登录却显示有账号、点退出登录报未知错误」（真出过一次）。
 * `isPluginAvailable` 查的是原生上报的 pluginHeaders，那才是真的。
 */
export const isSpotifyNativeAvailable = (): boolean => (
    isCapacitorAndroid() && Capacitor.isPluginAvailable('FoliaSpotify')
);

/** 走完一次 OAuth（授权码 + PKCE，没有 client secret）。取消 / 超时都是 ok:false。 */
export const requestSpotifyNativeSignIn = async (): Promise<SpotifySignInResult> => {
    if (!isSpotifyNativeAvailable()) {
        return { ok: false, error: { code: 'unavailable', message: 'Spotify sign-in is not available here' } };
    }
    try {
        const result = await FoliaSpotify.signIn();
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: false, error: { code: 'invalid-response', message: 'Spotify sign-in returned a malformed result' } };
    } catch (error) {
        return { ok: false, error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
};

/** 用 refresh token 换一对新的 token。 */
export const refreshSpotifyNativeSession = async (refreshToken: string): Promise<SpotifySignInResult> => {
    if (!isSpotifyNativeAvailable()) {
        return { ok: false, error: { code: 'unavailable', message: 'Spotify sign-in is not available here' } };
    }
    try {
        const result = await FoliaSpotify.refresh({ refreshToken });
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: false, error: { code: 'invalid-response', message: 'Spotify refresh returned a malformed result' } };
    } catch (error) {
        return { ok: false, error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
};
