import { createNativeFetch, isNativeHttpFetchAvailable } from './nativeHttpFetch';

// src/services/coverBytes.ts
// 取**封面字节**这一件事，供「要把封面交给原生」的那几处共用。
//
// 要它的人都不在乎 URL，只在乎拿到像素：原生歌词壁纸要把它编成 base64 当模糊底图，
// 通知栏要一张 Bitmap（系统进程渲染通知，拿不到 WebView 的缓存也带不上鉴权）。两处
// 以前各写了一遍 `fetch(url, { credentials: 'include' })`，犯的是同一个错（见下）。
//
// ⭐**第一跳不带凭据**（`credentials` 默认 same-origin，跨域请求因此不带 cookie）。
//
// 封面图床从来不需要 cookie，而带凭据的请求撞上一个 `Access-Control-Allow-Origin: *`
// 会被浏览器**直接判死**：带凭据的请求里通配符不作数，服务端必须回具体的源（Fetch 规范
// 那次 CORS 检查的第 3 步）。于是那一家回通配符的图床在这一步必然 `TypeError: Failed to
// fetch` —— 壁纸 / 通知栏拿不到图，而别的平台看着好好的：它们有的走缓存里那份 blob 地址
// （同源），有的压根不下发 CORS 头、走的是下面那条原生路。
//
// 取不到再走原生 OkHttp：它没有同源这一说，还自动带上 WebView 的 cookie。那些不下发
// CORS 头的 CDN（services/nativeAndroidBridge.ts 的 API_HOSTS 里记着几个）只有这条路
// 能拿到字节。没有桥（桌面 / 网页）时再退一次带凭据的页内请求 —— 自建服务那类「要 cookie
// 才给图」的地址靠它。

/** 一张封面而已：卡住就换下一条路，别拖着调用方。 */
const COVER_FETCH_TIMEOUT_MS = 20_000;

/** blob: / data: 只有页内这一条路可走（原生那边不认这两个协议）。 */
const isLocalBlobUrl = (url: string): boolean => (
    url.startsWith('blob:') || url.startsWith('data:')
);

export const fetchCoverBytes = async (url: string): Promise<Blob | null> => {
    if (typeof fetch !== 'function' || !url) return null;
    const local = isLocalBlobUrl(url);

    try {
        const response = await fetch(url);
        if (response.ok) return await response.blob();
        if (local) return null;
    } catch {
        if (local) return null;
        /* 跨域被拦：交给下面那条原生路。 */
    }

    if (!local && isNativeHttpFetchAvailable()) {
        try {
            const response = await createNativeFetch(COVER_FETCH_TIMEOUT_MS)(url, {
                headers: {
                    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    /* OkHttp 不像浏览器那样自己补 UA，有的图床见到没有 UA 的请求直接不给图。 */
                    'User-Agent': typeof navigator !== 'undefined' ? navigator.userAgent : '',
                },
            });
            if (response.ok) return await response.blob();
        } catch {
            /* 原生那条也没拿到：走最后一次页内尝试。 */
        }
    }

    try {
        const response = await fetch(url, { credentials: 'include' });
        if (response.ok) return await response.blob();
    } catch {
        /* 三条路都拿不到：这一首就是没有封面可取。 */
    }
    return null;
};
