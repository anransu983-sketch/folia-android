import { useEffect } from 'react';
import { markNativeBackKey } from '../utils/keyboardTargets';

// src/hooks/useNativeBackButton.ts
//
// Android 的返回键：先当一次 Escape 交给页面，没人接管才退到后台。
//
// 应用里所有弹层（设置、登录、命令面板）本来就监听 Escape 关自己，这里不重复实现一套
// 「当前有没有打开的层」的判断，而是复用那条链路：派发一个 Escape 键事件，被消费掉就说明
// 关掉了一层；没人消费（说明已经在主界面上）才把 App 挪到后台。
//
// 最后一步是**后台化而不是退出**：歌还在放，销毁 Activity 等于把这次会话整个扔掉
// （页面、播放页、搜索结果全丢，下次进来一切从头），用户看到的正是「返回键把 App 杀了」。
// 原生那边的兜底分支（网页没监听者时）同样是 moveTaskToBack，两边必须一致。

type NativeBackPlugin = {
    addListener: (
        eventName: string,
        listener: () => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
    /** 旧包只有 exitApp，新包才有它。没有就退回 exitApp，别让返回键彻底失灵。 */
    moveToBackground?: () => Promise<unknown>;
    exitApp?: () => Promise<unknown>;
};

const getPlugin = (): NativeBackPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeBackPlugin };
        };
    }).Capacitor;
    if (capacitor?.getPlatform?.() !== 'android') return null;
    const plugin = capacitor.Plugins?.FoliaNative;
    return plugin && typeof plugin.addListener === 'function' ? plugin : null;
};

export const useNativeBackButton = (): void => {
    useEffect(() => {
        const plugin = getPlugin();
        if (!plugin) return;

        const goBackground = () => {
            const action = typeof plugin.moveToBackground === 'function'
                ? plugin.moveToBackground
                : plugin.exitApp;
            if (!action) return;
            try {
                void Promise.resolve(action.call(plugin)).catch(() => undefined);
            } catch {
                // 插件不可用（桌面端 / 桥没起来）：静默，返回键不该把页面搞崩。
            }
        };

        let disposed = false;
        let listenerHandle: { remove: () => Promise<void> } | { remove: () => void } | null = null;
        const registered = plugin.addListener('backButton', () => {
            if (disposed) return;
            const event = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            // 打上标记：这一下是「回退一层」而不是键盘上逐级取消的 Esc（见 isNativeBackKey）。
            markNativeBackKey(event);
            const handled = !window.dispatchEvent(event) || event.defaultPrevented;
            if (!handled) goBackground();
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

        return () => {
            disposed = true;
            if (listenerHandle) void listenerHandle.remove();
        };
    }, []);
};

export default useNativeBackButton;
