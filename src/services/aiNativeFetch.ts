// src/services/aiNativeFetch.ts
// 浏览器直接请求 AI 服务会被 CORS 拦掉，安卓容器里改用已经存在的原生 OkHttp 桥转发。
//
// 那条转发本身与 AI 无关，已经抽到 services/nativeHttpFetch（别处也在用它绕过同源检查）；
// 这里是 AI 这个**用法**：更宽的超时 + 云缓存那条旁路。

import { createNativeFetch, isNativeHttpFetchAvailable, type NativeHttpPlugin } from './nativeHttpFetch';

/** AI 请求通常比接口调用慢，给一个比默认 45s 更宽的上限。 */
export const AI_REQUEST_TIMEOUT_MS = 180_000;

type NativeAiPlugin = NativeHttpPlugin & {
    /*
     * 云缓存的原生读法（FoliaNativePlugin.aiCloudCacheGet）。
     *
     * 可选：老版本 App 没有这个方法，那时照旧走 httpRequest 那条通用路。
     */
    aiCloudCacheGet?: (options: { key: string; url: string }) => Promise<{
        ok?: boolean;
        body?: string;
        cached?: boolean;
    } | null>;
};

const getNativePlugin = (): NativeAiPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            isPluginAvailable?: (name: string) => boolean;
            isNativePlatform?: () => boolean;
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeAiPlugin };
        };
    }).Capacitor;
    if (!capacitor) return null;
    if (capacitor.isNativePlatform?.() !== true && capacitor.getPlatform?.() !== 'android') return null;
    if (typeof capacitor.isPluginAvailable === 'function' && !capacitor.isPluginAvailable('FoliaNative')) return null;
    return capacitor.Plugins?.FoliaNative ?? null;
};

export const isAiBridgeFetchAvailable = (): boolean => isNativeHttpFetchAvailable();

/**
 * 安卓上读一条 AI 云缓存：请求由原生发出，答案留在原生侧。
 *
 * 为什么要绕开 httpRequest 那套通用转发：那一次是**网页发起**的，界面退到后台之后
 * WebView 的 JS 会被节流甚至冻住 —— 发起的那一步就卡在那儿，或者回调回来时 JS 已经
 * 不在跑，于是「切了歌，云缓存一次都没问」。交给原生，OkHttp 在自己的线程池里把请求
 * 做完，网页什么时候回来问都能拿到。
 *
 * 回的是**服务端响应体原文**，解析留给调用方；拿不到（没有这个方法、桥出错）返回 null，
 * 调用方照旧回落。
 */
export const fetchAiCacheViaNative = async (
    key: string,
    url: string,
): Promise<{ ok: boolean; body: string } | null> => {
    const plugin = getNativePlugin();
    if (!plugin?.aiCloudCacheGet) return null;
    try {
        const result = await plugin.aiCloudCacheGet({ key, url });
        if (!result || typeof result.body !== 'string' || !result.body) return null;
        return { ok: result.ok !== false, body: result.body };
    } catch {
        return null;
    }
};

/**
 * 返回一个与 fetch 同形的函数：安卓上走原生桥，其他平台回落到全局 fetch。
 * 只覆盖 AI 需要的用法（JSON 文本请求体），不做流式读取。
 */
export const createAiFetch = (): typeof fetch => createNativeFetch(AI_REQUEST_TIMEOUT_MS);
