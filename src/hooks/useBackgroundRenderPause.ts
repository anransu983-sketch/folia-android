import { useEffect } from 'react';

// src/hooks/useBackgroundRenderPause.ts
//
// 退后台时暂停整个界面的渲染，回前台再放开。真正干活的开关在
// utils/backgroundRenderGate.ts，这里只负责判断「现在是不是后台」。
//
// 两个来源，取或：
//
// 1. 原生事件（Android）。Activity onStop 才是真的看不见了 —— onPause 在下拉通知栏、
//    切多任务时也会来，那时画面还露着一半，不该停。桌面端没有这个来源。
// 2. document.visibilityState。桌面端切标签页、最小化走这条；Android 上作为兜底，
//    WebView 自己上报的可见性变化也能接住。
//
// 只挂在主界面上。壁纸叠层与桌面歌词是各自独立的窗口、独立的 document，它们要继续画，
// 所以都不挂这个 hook —— 挂了才会把它们的 rAF 一起关掉。

import { ensureBackgroundRenderGateInstalled, setBackgroundRenderSuspended } from '../utils/backgroundRenderGate';

type BackgroundListenerHandle = { remove: () => Promise<void> } | { remove: () => void };

type NativeBackgroundPlugin = {
    addListener: (
        eventName: string,
        listener: (payload?: { background?: boolean } | null) => void,
    ) => Promise<BackgroundListenerHandle> | BackgroundListenerHandle;
};

const getPlugin = (): NativeBackgroundPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeBackgroundPlugin };
        };
    }).Capacitor;
    if (capacitor?.getPlatform?.() !== 'android') return null;
    const plugin = capacitor.Plugins?.FoliaNative;
    return plugin && typeof plugin.addListener === 'function' ? plugin : null;
};

export const useBackgroundRenderPause = (): void => {
    useEffect(() => {
        ensureBackgroundRenderGateInstalled();

        // 视频解码是后台最抢 CPU 的一项，而且它不像 rAF 那样能被总闸拦住 —— <video>
        // 自己按媒体时钟走。暂停前记住谁在播，回前台原样放回去。
        const suspendVideos = () => {
            const videos = document.querySelectorAll<HTMLVideoElement>('video');
            for (const video of Array.from(videos)) {
                if (video.paused) continue;
                video.dataset.foliaBackgroundPaused = '1';
                video.pause();
            }
        };

        const resumeVideos = () => {
            const videos = document.querySelectorAll<HTMLVideoElement>('video[data-folia-background-paused]');
            for (const video of Array.from(videos)) {
                delete video.dataset.foliaBackgroundPaused;
                void video.play().catch(() => undefined);
            }
        };

        let nativeBackground = false;
        let applied = false;
        const sync = () => {
            const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
            const next = nativeBackground || hidden;
            if (next === applied) return;
            applied = next;
            setBackgroundRenderSuspended(next);
            if (next) {
                suspendVideos();
            } else {
                resumeVideos();
            }
        };

        let disposed = false;
        let listenerHandle: BackgroundListenerHandle | null = null;

        const plugin = getPlugin();
        if (plugin) {
            const registered = plugin.addListener('appBackground', payload => {
                if (disposed) return;
                nativeBackground = payload?.background !== false;
                sync();
            });
            Promise.resolve(registered)
                .then(handle => {
                    if (disposed) {
                        void handle.remove();
                        return;
                    }
                    listenerHandle = handle;
                })
                .catch(() => undefined);
        }

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', sync);
        }
        // 启动时就可能在后台（例如从通知栏恢复播放），先按当前可见性落一次。
        sync();

        return () => {
            disposed = true;
            if (listenerHandle) void listenerHandle.remove();
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', sync);
            }
            // 卸载（热更新、整棵树重挂载）不能把暂停状态留在那儿。
            if (applied) resumeVideos();
            setBackgroundRenderSuspended(false);
        };
    }, []);
};

export default useBackgroundRenderPause;
