// src/utils/frameRateLimiter.ts
// Shared helpers and global RAF gate for optional visualizer frame throttling.

import type { VisualizerFrameRate } from '../types';

type AnimationFrameCallback = FrameRequestCallback;
type RequestAnimationFrameFn = (callback: AnimationFrameCallback) => number;
type CancelAnimationFrameFn = (handle: number) => void;

type FrameRateLimitedRaf = {
    requestAnimationFrame: RequestAnimationFrameFn;
    cancelAnimationFrame: CancelAnimationFrameFn;
    setFrameRate: (frameRate: VisualizerFrameRate) => void;
    getFrameRate: () => VisualizerFrameRate;
};

type WindowWithVisualizerFrameRateLimiter = Window & {
    __foliaNativeRequestAnimationFrame?: RequestAnimationFrameFn;
    __foliaNativeCancelAnimationFrame?: CancelAnimationFrameFn;
};

export const VISUALIZER_FRAME_RATE_OPTIONS = [60, 90, 120] as const satisfies VisualizerFrameRate[];
export const VISUALIZER_FRAME_RATE_STORAGE_KEY = 'visualizer_frame_rate';
/** 性能模式（usePerformanceSettingsStore）给动画帧率定的上限：已有档位里最低的一档。 */
export const PERFORMANCE_FRAME_RATE_CAP: VisualizerFrameRate = 60;
const FRAME_INTERVAL_TOLERANCE_MS = 1;

export const isVisualizerFrameRate = (value: unknown): value is VisualizerFrameRate => (
    value === 'off'
    || value === 120
    || value === 90
    || value === 60
);

export const parseVisualizerFrameRate = (value: string | null): VisualizerFrameRate => {
    if (value === 'off' || value === 'auto' || value === null) {
        return 'off';
    }

    const parsed = Number(value);
    return isVisualizerFrameRate(parsed) ? parsed : 'off';
};

// Decides whether a RAF tick should run under the configured FPS cap.
export const shouldProcessFrameAtRate = (
    timestampMs: number,
    lastProcessedTimestampMs: number,
    frameRate: VisualizerFrameRate,
) => {
    if (frameRate === 'off') {
        return true;
    }

    const intervalMs = 1000 / frameRate - FRAME_INTERVAL_TOLERANCE_MS;
    return lastProcessedTimestampMs === 0 || timestampMs - lastProcessedTimestampMs >= intervalMs;
};

const reportAnimationFrameCallbackError = (error: unknown) => {
    console.error('Error in requestAnimationFrame callback:', error);
    setTimeout(() => {
        throw error;
    }, 0);
};

// Creates a shared RAF queue so every callback scheduled for an allowed frame flushes together.
export const createFrameRateLimitedRaf = (
    nativeRequestAnimationFrame: RequestAnimationFrameFn,
    nativeCancelAnimationFrame: CancelAnimationFrameFn,
    initialFrameRate: VisualizerFrameRate = 60,
): FrameRateLimitedRaf => {
    let frameRate = initialFrameRate;
    let nextHandle = 1;
    let nativeFrameHandle: number | null = null;
    let lastProcessedTimestamp = 0;
    const callbacks = new Map<number, AnimationFrameCallback>();

    const scheduleNativeFrame = () => {
        if (nativeFrameHandle !== null || callbacks.size === 0) {
            return;
        }

        nativeFrameHandle = nativeRequestAnimationFrame(processNativeFrame);
    };

    const processNativeFrame = (timestamp: number) => {
        nativeFrameHandle = null;

        if (!shouldProcessFrameAtRate(timestamp, lastProcessedTimestamp, frameRate)) {
            scheduleNativeFrame();
            return;
        }

        lastProcessedTimestamp = timestamp;
        const frameHandles = Array.from(callbacks.keys());

        for (const handle of frameHandles) {
            // Match native RAF: an earlier callback may cancel a later one in the same frame.
            const callback = callbacks.get(handle);
            if (!callback) continue;
            callbacks.delete(handle);
            try {
                callback(timestamp);
            } catch (error) {
                reportAnimationFrameCallbackError(error);
            }
        }

        scheduleNativeFrame();
    };

    return {
        requestAnimationFrame: (callback) => {
            const handle = nextHandle;
            nextHandle += 1;
            callbacks.set(handle, callback);
            scheduleNativeFrame();
            return handle;
        },
        cancelAnimationFrame: (handle) => {
            callbacks.delete(handle);
            if (callbacks.size === 0 && nativeFrameHandle !== null) {
                nativeCancelAnimationFrame(nativeFrameHandle);
                nativeFrameHandle = null;
            }
        },
        setFrameRate: (nextFrameRate) => {
            frameRate = nextFrameRate;
            lastProcessedTimestamp = 0;

            if (nativeFrameHandle !== null) {
                nativeCancelAnimationFrame(nativeFrameHandle);
                nativeFrameHandle = null;
            }
            scheduleNativeFrame();
        },
        getFrameRate: () => frameRate,
    };
};

let installedLimiter: FrameRateLimitedRaf | null = null;

// 性能模式的上限与用户自己选的帧率是两件事：用户的值原样记在 requestedFrameRate 里，
// 闸上真正生效的是 resolveEffectiveVisualizerFrameRate 合出来的结果。上限关掉，用户的值
// 一个档位不动地回来；上限开着时用户改设置也只改 requested，生效值仍被压住。
let performanceCapEnabled = false;
let requestedFrameRate: VisualizerFrameRate | null = null;

/** 用户要的帧率与性能上限合出来的实际帧率：上限关着时原样，上限开着时超过上限的（包括「不限制」）压到上限。 */
export const resolveEffectiveVisualizerFrameRate = (
    requested: VisualizerFrameRate,
    capEnabled: boolean,
): VisualizerFrameRate => {
    if (!capEnabled) {
        return requested;
    }
    if (requested === 'off') {
        return PERFORMANCE_FRAME_RATE_CAP;
    }
    return Math.min(requested, PERFORMANCE_FRAME_RATE_CAP) as VisualizerFrameRate;
};

const applyGlobalVisualizerFrameRate = (frameRate: VisualizerFrameRate) => {
    if (frameRate === 'off') {
        restoreGlobalVisualizerFrameRateLimiter();
        return;
    }

    if (!installedLimiter) {
        installGlobalVisualizerFrameRateLimiter(frameRate);
        return;
    }

    installedLimiter.setFrameRate(frameRate);
};

export const setGlobalVisualizerFrameRate = (frameRate: VisualizerFrameRate) => {
    if (typeof window === 'undefined') {
        return;
    }

    requestedFrameRate = frameRate;
    applyGlobalVisualizerFrameRate(resolveEffectiveVisualizerFrameRate(frameRate, performanceCapEnabled));
};

/**
 * 性能模式开关动画帧率上限。由 usePerformanceSettingsStore 在开关变化（和模块加载）时调：
 * 这里只记上限开没开，再按记住的用户帧率重新合一次生效值。
 */
export const setPerformanceFrameRateCap = (enabled: boolean) => {
    if (typeof window === 'undefined') {
        return;
    }

    performanceCapEnabled = enabled;
    const requested = requestedFrameRate
        ?? parseVisualizerFrameRate(window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY));
    requestedFrameRate = requested;
    applyGlobalVisualizerFrameRate(resolveEffectiveVisualizerFrameRate(requested, enabled));
};

// Asks for the display's next frame, past the cap. For work that has to land in the same frame as
// something the cap does not hold back: a library that took `requestAnimationFrame` before the cap
// was switched on (framer-motion does, when its module loads) keeps running on every display frame.
export const requestUncappedAnimationFrame = (callback: AnimationFrameCallback): number => {
    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    return (frameWindow.__foliaNativeRequestAnimationFrame ?? window.requestAnimationFrame).call(window, callback);
};

// Cancels a frame asked for with `requestUncappedAnimationFrame`.
export const cancelUncappedAnimationFrame = (handle: number) => {
    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    (frameWindow.__foliaNativeCancelAnimationFrame ?? window.cancelAnimationFrame).call(window, handle);
};

export const restoreGlobalVisualizerFrameRateLimiter = () => {
    if (typeof window === 'undefined') {
        return;
    }

    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    if (frameWindow.__foliaNativeRequestAnimationFrame) {
        window.requestAnimationFrame = frameWindow.__foliaNativeRequestAnimationFrame;
    }
    if (frameWindow.__foliaNativeCancelAnimationFrame) {
        window.cancelAnimationFrame = frameWindow.__foliaNativeCancelAnimationFrame;
    }
    installedLimiter = null;
};

export const installGlobalVisualizerFrameRateLimiter = (overrideFrameRate?: VisualizerFrameRate) => {
    if (typeof window === 'undefined') {
        return;
    }

    const initialFrameRate = overrideFrameRate
        ?? parseVisualizerFrameRate(window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY));
    // 经 setGlobalVisualizerFrameRate / setPerformanceFrameRateCap 进来时，用户的值已经记下了，
    // 这里的 initialFrameRate 是合过上限的生效值，不能拿它把用户的值盖掉。
    requestedFrameRate ??= initialFrameRate;
    const effectiveFrameRate = resolveEffectiveVisualizerFrameRate(initialFrameRate, performanceCapEnabled);
    if (effectiveFrameRate === 'off') {
        restoreGlobalVisualizerFrameRateLimiter();
        return;
    }

    if (installedLimiter) {
        installedLimiter.setFrameRate(effectiveFrameRate);
        return;
    }

    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    frameWindow.__foliaNativeRequestAnimationFrame ??= window.requestAnimationFrame;
    frameWindow.__foliaNativeCancelAnimationFrame ??= window.cancelAnimationFrame;
    const nativeRequestAnimationFrame: RequestAnimationFrameFn = (callback) => (
        frameWindow.__foliaNativeRequestAnimationFrame?.call(window, callback) ?? 0
    );
    const nativeCancelAnimationFrame: CancelAnimationFrameFn = (handle) => {
        frameWindow.__foliaNativeCancelAnimationFrame?.call(window, handle);
    };
    installedLimiter = createFrameRateLimitedRaf(nativeRequestAnimationFrame, nativeCancelAnimationFrame, effectiveFrameRate);

    window.requestAnimationFrame = installedLimiter.requestAnimationFrame;
    window.cancelAnimationFrame = installedLimiter.cancelAnimationFrame;
};
