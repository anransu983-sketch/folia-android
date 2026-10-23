// src/utils/backgroundRenderGate.ts
//
// 后台渲染总闸：应用退到后台（Android 上 Activity 停了、桌面端切走标签页）时，
// 把整个界面的渲染开销压到零。
//
// 为什么需要它：退后台后画面根本没人看，可 WebView 里的动画循环照样按 60fps 跑 ——
// 可视化在画 WebGL、CSS 动画在合成、补间在重排布局。这些活和音频解码抢的是同一颗核，
// 抢输了就是用户听到的「后台播放撕裂」。后台把渲染让出来，音频才有稳定的时间片。
//
// 后台是一帧都不画，不是降频。
//
// 试过留一秒一次的低频心跳：看起来更稳妥（借 rAF 推进的退出动画、测量后的定位、下一帧
// 再卸载的节点都还能走完），可每一拍仍然要实打实地画一整帧 —— 可视化场景复杂时那一帧
// 就要二三十毫秒，正好是一次音频缓冲的长度。降频只是把撕裂从「一直响」变成「每秒一下」。
// 要的就是彻底安静。
//
// 那些借 rAF 推进的逻辑并不会因此坏掉：它们停在半途，回到前台一次性补上就继续走完。
// 常驻的循环都是「回调里再排下一帧」，回调不执行就不会再排，所以挂起的回调数量等于活跃
// 循环的个数，不会因为后台待久了越积越多。
//
// 只影响调用它的那个 window：壁纸叠层（wallpaper.html）与桌面歌词是各自独立的 document，
// 它们要继续渲染，碰不到这里的开关。

type FrameCallback = FrameRequestCallback;

/**
 * 假 handle 的起始值，与浏览器自己发的 handle 错开。
 *
 * 后台时我们返回自己的 handle，前台时直接转发浏览器的。取消时要靠数值判断该清谁的，
 * 撞号就会误取消掉别人的一帧 —— 浏览器的 handle 从小到大发、远小于这个值。
 */
const PENDING_HANDLE_BASE = 0x5f000000;

/**
 * 挂起回调的上限。
 *
 * 常驻循环每人只占一格，真正会堆的是「事件或定时器里注册的一次性 rAF」—— 后台收个
 * 通知、定时器走一拍都可能注册一个。堆到这个数就把最早的丢掉：丢的是一次延迟执行的
 * 便利，不是状态，回前台该重算的还会重算。
 */
const PENDING_FRAME_LIMIT = 256;

type WindowWithGate = Window & {
    __foliaBackgroundRequestAnimationFrame?: (callback: FrameCallback) => number;
    __foliaBackgroundCancelAnimationFrame?: (handle: number) => void;
};

let suspended = false;
let installed = false;
let nextHandle = PENDING_HANDLE_BASE;
const pendingFrames = new Map<number, FrameCallback>();
const listeners = new Set<(suspended: boolean) => void>();

const reportFrameError = (error: unknown) => {
    console.error('Error in background animation frame callback:', error);
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 回到前台：把挂起的那些回调按注册顺序补跑一遍，它们自己会重新开循环。 */
const flushPendingFrames = () => {
    if (pendingFrames.size === 0) return;
    const entries = Array.from(pendingFrames.entries());
    pendingFrames.clear();
    const timestamp = now();
    for (const [, callback] of entries) {
        try {
            callback(timestamp);
        } catch (error) {
            reportFrameError(error);
        }
    }
};

/**
 * 接管 window.requestAnimationFrame。
 *
 * 前台：原样转发，零开销、零行为差异。
 * 后台：只登记不排队，浏览器一帧都不用给。
 */
const installGate = () => {
    if (installed || typeof window === 'undefined') return;
    installed = true;

    const frameWindow = window as WindowWithGate;
    frameWindow.__foliaBackgroundRequestAnimationFrame ??= window.requestAnimationFrame.bind(window);
    frameWindow.__foliaBackgroundCancelAnimationFrame ??= window.cancelAnimationFrame.bind(window);
    const nativeRequest = frameWindow.__foliaBackgroundRequestAnimationFrame;
    const nativeCancel = frameWindow.__foliaBackgroundCancelAnimationFrame;
    if (!nativeRequest || !nativeCancel) return;

    window.requestAnimationFrame = (callback: FrameCallback) => {
        if (!suspended) return nativeRequest(callback);
        const handle = nextHandle;
        nextHandle += 1;
        pendingFrames.set(handle, callback);
        if (pendingFrames.size > PENDING_FRAME_LIMIT) {
            const oldest = pendingFrames.keys().next().value;
            if (oldest !== undefined) pendingFrames.delete(oldest);
        }
        return handle;
    };

    window.cancelAnimationFrame = (handle: number) => {
        if (pendingFrames.delete(handle)) return;
        nativeCancel(handle);
    };
};

/** 后台时为 true。渲染循环可以读它来决定要不要继续画。 */
export const isBackgroundRenderSuspended = (): boolean => suspended;

/** 供需要在前后台切换时做一次性收尾（比如把预取的活压后）的模块订阅。 */
export const subscribeBackgroundRenderSuspended = (listener: (suspended: boolean) => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const setBackgroundRenderSuspended = (next: boolean): void => {
    if (suspended === next) return;
    installGate();
    suspended = next;

    // 动画与过渡交给 CSS 一次性停掉（见 index.css 的 [data-folia-background] 段），
    // 比逐个组件去判断便宜得多，也不会漏掉第三方组件自带的动画。
    //
    // 回前台的顺序是反的：先摘属性再补跑回调，否则回调里排的下一帧又会被关进挂起队列。
    if (!next) flushPendingFrames();

    if (typeof document !== 'undefined') {
        if (next) {
            document.documentElement.setAttribute('data-folia-background', '1');
        } else {
            document.documentElement.removeAttribute('data-folia-background');
        }
    }

    for (const listener of Array.from(listeners)) {
        try {
            listener(next);
        } catch (error) {
            console.error('Error in background render listener:', error);
        }
    }
};

/** 入口处调一次，确保 rAF 在任何循环开始之前就已经过闸。 */
export const ensureBackgroundRenderGateInstalled = (): void => {
    installGate();
};
