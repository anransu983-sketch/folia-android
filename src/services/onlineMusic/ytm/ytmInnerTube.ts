import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../../../platform/runtime';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { AudioQualityPreference } from '../../../types/onlineMusic';
import { YTM_ASKED_TO_WAIT } from './ytmFailure';
import type { YtmNativeSession } from './ytmNative';

// src/services/onlineMusic/ytm/ytmInnerTube.ts
//
// YouTube Music 在安卓上取**音频直链**的那一跳：原生 FoliaInnerTube 桥。
//
// 为什么取数能走页内 youtubei.js、取流却非得下原生：页内那条 WEB 路取流要
// poToken（BotGuard 证明），WebView 里产不出来；官方 App 客户端（ANDROID_VR
// 等）目前不查 poToken，但它们的请求形态（客户端字段、UA、visitorData）得由
// 原生 OkHttp 逐字冒充，JS 侧拼不齐。所以分工是：**取数在页内、取流在桥内**，
// 桥只回一条 googlevideo 直链，喂给 provider 的现行播放入口。
//
// 会话怎么过桥：登录在 FoliaYtm 那边做完后 cookie 存在页内 runtime 的内存里，
// 取流时随调用递给桥（allowSignedIn 时），桥内现算 SAPISIDHASH、用完即弃 ——
// cookie 不落盘、不进日志、不进错误信息（与 ytmNative 同一条规矩）。
//
// 失败怎么报：桥的失败码在这里翻成 OnlineProviderError，沿用这一家既有的
// 失败分类（ytmFailure）：429 走 `network` + 那句定稿文案（界面认它给「稍后再
// 试」）；全链撞登录门走 `not-playable` + 句尾 (LOGIN_REQUIRED)（ytmFailure
// 靠句尾的大写词认出 sign-in-needed）；地区限制走 `region-restricted`。不再
// 一律塌成「未知错误」。

/** 桥逐级试过的客户端一行记录，只报客户端名与失败类别，不含任何地址或凭据。 */
export type YtmBridgeAttempt = { client: string; code: string; detail?: string };

export type YtmBridgeStream = {
    /** googlevideo 音频直链（原始地址，回环代理的替换在 runtime 那一跳做）。 */
    url: string;
    /** 命中的客户端线路名（登录链命中带 +signed-in 后缀）。 */
    route: string;
    /**
     * 铸链那个客户端的 UA。取流必须带同一个 UA：googlevideo 按铸链时的请求形态认人，
     * 换 UA 取流会被拒、只回空包（0.7.22.8 真机定性）。旧桥答复没有这一项时为空，
     * 取流回落到代理自己的默认 UA，不报错。
     */
    userAgent?: string;
    itag?: number;
    bitrate?: number;
    /** 实际给到的档位：要 ultra 桥降到 high 时以桥的为准（provider 同口径）。 */
    level?: AudioQualityPreference;
};

// 桥的答复形状是设计稿 §4.2 的契约：成功在 stream 里、失败在 error 里，别拍平——
// 拍平读会把每个成功都读成「形状不对」。
type YtmBridgeResolveAnswer =
    | { ok: true; stream: { url: string; route: string; userAgent?: string; itag?: number; bitrate?: number; level?: string } }
    | { ok: false; error: { code: string; message: string; attempts?: YtmBridgeAttempt[] } };

type YtmBridgeStatus = { ready: boolean; visitorData: string; egress: string };

interface FoliaInnerTubePlugin {
    status(): Promise<YtmBridgeStatus>;
    resolveStream(options: {
        videoId: string;
        quality: string;
        allowSignedIn: boolean;
        session?: { cookie: string; userAgent: string };
    }): Promise<YtmBridgeResolveAnswer>;
}

const FoliaInnerTube = registerPlugin<FoliaInnerTubePlugin>('FoliaInnerTube');

/**
 * 桥在不在。与 ytmNative 同一条血泪规矩：必须 `Capacitor.isPluginAvailable`，
 * 不能摸代理对象的方法 —— 代理对任何方法名都答 function。
 */
export const isYtmInnerTubeAvailable = (): boolean => (
    isCapacitorAndroid() && Capacitor.isPluginAvailable('FoliaInnerTube')
);

/** 最近一次取流的一行摘要（进登录诊断报告；只有线路名/类别/itag，没有地址与凭据）。 */
let lastResolveLine: string | null = null;
/** 桥状态的缓存：诊断是同步读的，状态在取流前顺手刷一次。 */
let bridgeStatus: YtmBridgeStatus | null = null;
let bridgeStatusFetched = false;

const attemptsText = (attempts: YtmBridgeAttempt[] | undefined): string => (
    (attempts ?? []).map(line => `${line.client}: ${line.code}`).join('; ')
);

/** 取流前把桥状态刷进缓存（一个进程只刷一次；失败不挡取流，诊断里如实写没刷到）。 */
const refreshBridgeStatus = async (): Promise<void> => {
    if (bridgeStatusFetched || !isYtmInnerTubeAvailable()) return;
    bridgeStatusFetched = true;
    try {
        bridgeStatus = await FoliaInnerTube.status();
    } catch {
        bridgeStatus = null;
    }
};

/** 诊断用：桥在不在、visitor 在不在手、出口自检结论、最近一次取流摘要。 */
export const getYtmInnerTubeDiagnostics = (): string[] => {
    const lines = [`innertube bridge: ${isYtmInnerTubeAvailable() ? 'available' : 'not available'}`];
    if (bridgeStatus) {
        lines.push(`visitor data: ${bridgeStatus.visitorData}`);
        lines.push(`stream egress: ${bridgeStatus.egress}`);
    }
    if (lastResolveLine) lines.push(lastResolveLine);
    return lines;
};

/** 桥的失败码 → 这一家既有的错误分类（映射口径见文件头）。 */
const bridgeFailure = (answer: { code: string; message: string; attempts?: YtmBridgeAttempt[] }): OnlineProviderError => {
    const trail = attemptsText(answer.attempts);
    const withTrail = trail ? `${answer.message} [${trail}]` : answer.message;
    switch (answer.code) {
        case 'rate-limited':
            // 桌面端同口径：429 是 network 码 + 这句定稿文案，ytmFailure 认文案给 retry-later。
            return new OnlineProviderError('network', YTM_ASKED_TO_WAIT, 'ytm');
        case 'login-required':
            // 句尾的 (LOGIN_REQUIRED) 是 ytmFailure 提取状态词的位置，sign-in-needed 靠它。
            return new OnlineProviderError('not-playable', `${answer.message} (LOGIN_REQUIRED)`, 'ytm');
        case 'region-restricted':
            return new OnlineProviderError('region-restricted', withTrail, 'ytm');
        case 'not-playable':
            return new OnlineProviderError('not-playable', withTrail, 'ytm');
        case 'egress-blocked':
            // 链拿到了、字节过不来：网络类，但把「出口」写进文案，别和真断网混。
            return new OnlineProviderError('network', withTrail, 'ytm');
        case 'invalid-response':
        case 'invalid-request':
            return new OnlineProviderError('invalid-response', withTrail, 'ytm');
        case 'network':
            return new OnlineProviderError('network', withTrail, 'ytm');
        default:
            return new OnlineProviderError('unavailable', withTrail, 'ytm');
    }
};

/**
 * 经桥取一条音频直链。成功回直链本体（回环代理替换由调用方做）；失败抛
 * OnlineProviderError。桥不在（非安卓/旧包）时抛 `unsupported`，与 audio
 * 以前显式 unsupported 的报错同码，不静默吞。
 */
export const resolveYtmStreamViaBridge = async (input: {
    videoId: string;
    quality: AudioQualityPreference;
    session: YtmNativeSession | null;
}): Promise<YtmBridgeStream> => {
    if (!isYtmInnerTubeAvailable()) {
        throw new OnlineProviderError('unsupported', 'YouTube Music audio is not available on Android yet', 'ytm');
    }
    await refreshBridgeStatus();
    const startedAt = Date.now();
    let answer: YtmBridgeResolveAnswer;
    try {
        answer = await FoliaInnerTube.resolveStream({
            videoId: input.videoId,
            quality: input.quality,
            allowSignedIn: input.session !== null,
            ...(input.session ? { session: { cookie: input.session.cookie, userAgent: input.session.userAgent } } : {}),
        });
    } catch (error) {
        lastResolveLine = `last resolve: bridge call itself failed (${error instanceof Error ? error.name : 'unknown'})`;
        throw new OnlineProviderError('unavailable', 'The InnerTube bridge did not answer', 'ytm', error);
    }
    if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
        lastResolveLine = 'last resolve: malformed bridge answer';
        throw new OnlineProviderError('invalid-response', 'The InnerTube bridge answered in a shape that is not readable', 'ytm');
    }
    if (!answer.ok) {
        const error = answer.error;
        if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
            lastResolveLine = 'last resolve: malformed bridge failure';
            throw new OnlineProviderError('invalid-response', 'The InnerTube bridge answered in a shape that is not readable', 'ytm');
        }
        lastResolveLine = `last resolve: failed (${error.code}), ${Date.now() - startedAt}ms${attemptsText(error.attempts) ? ` — ${attemptsText(error.attempts)}` : ''}`;
        console.warn('[Ytm] InnerTube bridge could not resolve a stream', lastResolveLine);
        throw bridgeFailure(error);
    }
    const stream = answer.stream;
    if (!stream || typeof stream.url !== 'string' || !stream.url.startsWith('https://') || typeof stream.route !== 'string' || !stream.route) {
        lastResolveLine = 'last resolve: bridge claimed success without a stream address';
        throw new OnlineProviderError('invalid-response', 'The InnerTube bridge answered in a shape that is not readable', 'ytm');
    }
    lastResolveLine = `last resolve: ok via ${stream.route}${stream.itag ? ` (itag ${stream.itag})` : ''}, ${Date.now() - startedAt}ms`;
    console.log(`[Ytm] InnerTube bridge resolved a stream via ${stream.route}${stream.itag ? ` (itag ${stream.itag})` : ''}`);
    return {
        url: stream.url,
        route: stream.route,
        ...(typeof stream.userAgent === 'string' && stream.userAgent ? { userAgent: stream.userAgent } : {}),
        ...(typeof stream.itag === 'number' ? { itag: stream.itag } : {}),
        ...(typeof stream.bitrate === 'number' ? { bitrate: stream.bitrate } : {}),
        ...(stream.level === 'standard' || stream.level === 'high' || stream.level === 'ultra'
            ? { level: stream.level }
            : {}),
    };
};
