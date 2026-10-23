// src/services/phoneInsets.ts
//
// 安卓的真实安全区。
//
// 网页这边的 `env(safe-area-inset-*)` 在安卓上不可信，三条原因叠在一起：
//
// 1. Android WebView 只报告**屏幕缺口（cutout）**，从不报告**系统栏** —— 没有刘海的机器上
//    四项全是 0px；有刘海的也只给刘海高度，不给状态栏高度。
// 2. targetSdk 35+（我们是 36）系统强制边到边，内容确实画到了系统栏下面，
//    可网页拿到的避让量是 0 —— 于是顶部被状态栏压住、底部被手势条压住。
// 3. 国产 ROM 的 WebView 内核常常干脆不透传 env()，旧 Chromium（<140）还会直接报 0px。
//
// 所以数值由原生侧算（PhoneFitCutout.resolveInsets，用 getInsetsIgnoringVisibility 按
// 「系统栏会占多少」算，而不是「现在占了没」），这里只负责把它落到 CSS 变量上。
//
// 落在 inline style 上而不是 :root 规则里：inline 优先级最高，能盖住 index.css 里那份
// `env()` 兜底 —— 桌面端与 iOS 照旧走 env()，安卓用原生这份真值。

import { isAndroidNativeRuntime } from './nativeLocalMusic';

export type PhoneInsets = {
    top: number;
    right: number;
    bottom: number;
    left: number;
};

const CSS_VARIABLES: Record<keyof PhoneInsets, string> = {
    top: '--folia-safe-area-top',
    right: '--folia-safe-area-right',
    bottom: '--folia-safe-area-bottom',
    left: '--folia-safe-area-left',
};

const ZERO: PhoneInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const clampInset = (value: unknown): number => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    // 一个 sane 上限：再大就是 ROM 报错值，按它内缩整屏就废了。
    return Math.min(Math.round(number), 200);
};

const readPayload = (payload: unknown): PhoneInsets => {
    const record = (payload ?? {}) as Record<string, unknown>;
    return {
        top: clampInset(record.top),
        right: clampInset(record.right),
        bottom: clampInset(record.bottom),
        left: clampInset(record.left),
    };
};

let current: PhoneInsets = { ...ZERO };

/**
 * 数值从哪来的 —— 诊断页要显示它，不然「顶上没让开」根本分不清是没算出来还是没生效。
 *
 * · `native`：原生算好了发过来（正常情况）；
 * · `env`：不在安卓 WebView 里，用的是 index.css 那份 `env(safe-area-inset-*)`；
 * · `unavailable`：跑在安卓上但插件桥没接上。
 */
export type PhoneInsetsSource = 'native' | 'env' | 'unavailable';

let source: PhoneInsetsSource = 'env';

export const getPhoneInsetsSource = (): PhoneInsetsSource => source;

/** 关掉避让时一律读 0 —— 与写进 CSS 变量的那一份保持一致（见 setSafeAreaBypass）。 */
export const getPhoneInsets = (): PhoneInsets => (safeAreaBypass ? { ...ZERO } : { ...current });

type PhoneInsetsListener = (insets: PhoneInsets) => void;
const listeners = new Set<PhoneInsetsListener>();

export const subscribePhoneInsets = (listener: PhoneInsetsListener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/**
 * 叠层（系统悬浮层）那一页的入口 —— 它是**另一个 WebView / document**。
 *
 * 那儿没有 Capacitor 桥（`installPhoneInsets` 进去只会拿到 'unavailable'，四项永远 0），
 * 而它画在桌面 / 锁屏之上、又是 `setFitInsetsTypes(0)` 的满屏窗口 —— 状态栏和手势条
 * 照样盖在它上面。商籁右上角那行歌曲描述画在 Pixi 画布里，CSS 那套
 * `data-folia-safe-top` 够不着，只能靠 `getPhoneInsets().top`；在那儿读到的却是 0。
 *
 * 所以数值由原生跟着状态包一起推下来（`WallpaperOverlay.buildPayload` 的 `insets`），
 * 这里只负责把它落到同一份 `current` 和 CSS 变量上 —— 画布里那行描述读到的就是真值，
 * 和应用里那一行用的是同一份口径。
 */
export const applyPushedPhoneInsets = (payload: unknown): void => {
    source = 'native';
    apply(readPayload(payload));
};

/**
 * 全 0 一律不写。
 *
 * 手机上不存在「状态栏高度 0」这回事，四个数同时为 0 只可能是**还没量到**（首帧窗口 inset
 * 还没派下来，getPhoneInsets 抢跑了一步）。这时候把 0 写进 inline style 会**覆盖掉** index.css
 * 里那份 env() 兜底 —— 本来还能用的那个值反而被抹了；留着不写，等监听里那次真值到了再覆盖。
 *
 * inset 也不会从有变无，所以一旦写过真值，后面再来全 0 同样不覆盖。
 */
const isUnmeasured = (value: PhoneInsets): boolean => (
    value.top === 0 && value.right === 0 && value.bottom === 0 && value.left === 0
);

/*
 * 平板与手机横屏**不做安全区避让**：屏一直够宽（平板）或者横过来之后整块都是内容区
 * （手机横屏的高度本来就只有 360~400，再让掉状态栏 + 手势条就没什么可放了）。
 * 只有手机竖屏需要让 —— 顶上状态栏、底下手势条都实实在在压在内容上。
 *
 * 由 androidPhoneLayout.applyDeviceProfile 按设备类型与朝向设置。
 */
let safeAreaBypass = false;

/** 上一次真正写进 CSS 变量的值，用来判断有没有变。 */
let written: PhoneInsets = { ...ZERO };

const writeToRoot = (values: PhoneInsets): void => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    (Object.keys(CSS_VARIABLES) as Array<keyof PhoneInsets>).forEach(side => {
        root.style.setProperty(CSS_VARIABLES[side], `${values[side]}px`);
    });
};

const apply = (next: PhoneInsets): void => {
    const measured = !isUnmeasured(next);
    if (measured) {
        current = next;
    }
    /*
     * 全 0 一律不写（见 isUnmeasured 那条注释）—— 但**「不需要避让」时例外**：
     * 那种情况要的就是主动把四个方向压成 0，否则 index.css 里那份 env() 兜底
     * 会继续生效（平板上它可能仍报着挖孔高度），等于没关掉。
     */
    if (!measured && !safeAreaBypass) {
        return;
    }
    const values = safeAreaBypass ? { ...ZERO } : { ...current };
    const changed = (Object.keys(CSS_VARIABLES) as Array<keyof PhoneInsets>)
        .some(side => written[side] !== values[side]);
    written = values;
    writeToRoot(values);
    if (!changed) return;
    listeners.forEach(listener => listener(getPhoneInsets()));
};

/**
 * 打开 / 关闭「不做安全区避让」。
 *
 * 关掉避让后连 `getPhoneInsets()` 也一起归零：可视化那一层用它把歌词描述摆在
 * Pixi 画布里（CSS 够不着），读数与 CSS 变量必须是同一份口径，否则同一行字
 * 在两处的位置会不一样。
 */
export const setSafeAreaBypass = (bypass: boolean): void => {
    if (safeAreaBypass === bypass) return;
    safeAreaBypass = bypass;
    apply(current);
};

type PhoneInsetsPlugin = {
    getPhoneInsets?: () => Promise<Record<string, unknown>>;
    addListener?: (
        eventName: string,
        listener: (payload: Record<string, unknown>) => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
};

const getPlugin = (): PhoneInsetsPlugin | null => (
    (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
        .Capacitor?.Plugins?.FoliaNative as PhoneInsetsPlugin | null ?? null
);

let started = false;

/**
 * 装上安卓安全区。可以重复调用（只在第一次真正干活）。
 *
 * 两条路都要：事件只能覆盖「变了之后」，而首屏那一帧页面往往还没监听上 ——
 * 所以先主动拉一次，再订阅后续变化。
 */
export const installPhoneInsets = (): void => {
    if (started) return;
    started = true;
    if (!isAndroidNativeRuntime()) {
        source = 'env';
        return;
    }
    const plugin = getPlugin();
    if (!plugin) {
        source = 'unavailable';
        return;
    }
    source = 'native';

    if (plugin.getPhoneInsets) {
        void plugin.getPhoneInsets()
            .then(payload => apply(readPayload(payload)))
            .catch(() => undefined);
    }

    if (!plugin.addListener) return;
    // 返回值在真机上两种都见过（Promise 与直接返回句柄），统一包一层再兜住失败。
    void Promise.resolve(plugin.addListener('phoneInsets', (payload: Record<string, unknown>) => {
        apply(readPayload(payload));
    })).catch(() => undefined);
};
