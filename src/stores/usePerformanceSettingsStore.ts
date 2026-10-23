import { create } from 'zustand';
import { isCapacitorAndroid } from '../platform/runtime';
import { setPerformanceFrameRateCap } from '../utils/frameRateLimiter';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// src/stores/usePerformanceSettingsStore.ts
// 「性能模式」：只在安卓 App 里有意义的一个渲染降级总开关（设置在「性能与动效」页）。
//
// 存在的理由是真机帧率：海报墙（bravais / lattice 的拼贴）是桌面级的渲染量，中低端手机拖墙
// 掉帧明显。这个开关把几处「贵且纯装饰」的开销一次性降下来，只动渲染层，不改任何功能与
// 数据，默认关 —— 观感优先，要流畅的人自己开。开启立即生效，不用重启也不用重进页面：
//
//   1. <html data-folia-performance-mode> —— index.css 与 bravaisCollection.css 据此关掉
//      backdrop blur、磁贴阴影和加载中的呼吸动画（纯 CSS 降级）。
//   2. 动画帧率上限 60 —— 复用 visualizer 的帧率闸（utils/frameRateLimiter 的性能上限），
//      用户自己的帧率设置原样保留，关掉性能模式就恢复。
//   3. 海报墙的预渲染范围 —— bravais 的度量 getter 与 lattice 的 PosterWall 读
//      readPerformanceMode() 取小档，拖动时少渲染一圈磁贴。
//
// 刻意不进外观配置的导入导出，和降低动态效果（useMotionSettingsStore）同一个理由：这是
// 「这台设备跑不跑得动」的本机取舍，不是外观品味，导入别人的配置顺手把自己的帧率压到 60
// 是 bug，不是功能。
//
// 开关原值三个平台都存，效果点一律先过 isCapacitorAndroid()：桌面与 Web 端设置页不画这一
// 行，命令也只在安卓注册，存下的值不会在那边生效。

// key 写成独立字面量常量：storeContract 的快照靠扫描源码字面量盯住改名，拼出来的 key 它看不见。
const PERFORMANCE_MODE_KEY = 'performance_mode';

export type PerformanceSettingsState = {
    /** 用户拨的开关原值（未过平台门控）；默认关。 */
    performanceMode: boolean;
    handleTogglePerformanceMode: (enabled: boolean) => void;
};

export const usePerformanceSettingsStore = create<PerformanceSettingsState>(set => ({
    performanceMode: getStoredBoolean(PERFORMANCE_MODE_KEY, false),

    handleTogglePerformanceMode: (enabled) => {
        setStoredBoolean(PERFORMANCE_MODE_KEY, enabled);
        set({ performanceMode: enabled });
    },
}));

/** 性能模式此刻是否真的在降级：开关开着，且确实跑在安卓 App 里。 */
export const resolvePerformanceMode = (
    state: Pick<PerformanceSettingsState, 'performanceMode'>,
): boolean => state.performanceMode && isCapacitorAndroid();

/** 非响应式读取，给相机回调、度量 getter 这类只在动作发生时取值的地方用。 */
export const readPerformanceMode = (): boolean => (
    resolvePerformanceMode(usePerformanceSettingsStore.getState())
);

/** React 订阅版：开关变化时重渲染（平台判定在运行时不会变，不必订阅它）。 */
export const usePerformanceMode = (): boolean => (
    usePerformanceSettingsStore(state => state.performanceMode) && isCapacitorAndroid()
);

/**
 * 把生效状态同步到两个非 React 的效果点：<html> 属性（CSS 读）和帧率闸（命令式全局状态）。
 *
 * 和 useMotionSettingsStore 的 data-reduce-motion 同步一样挂在模块级：bootstrap 按 URL 挂的
 * 窗口不止主界面一个，只在某个根组件的 effect 里同步，其它窗口永远拿不到。import 时先写
 * 一次，第一帧就是对的。
 */
const syncPerformanceModeEffects = (state: PerformanceSettingsState): void => {
    if (typeof window === 'undefined') return;
    const effective = resolvePerformanceMode(state);
    if (typeof document !== 'undefined' && document.documentElement) {
        if (effective) {
            document.documentElement.setAttribute('data-folia-performance-mode', '1');
        } else {
            document.documentElement.removeAttribute('data-folia-performance-mode');
        }
    }
    setPerformanceFrameRateCap(effective);
};

syncPerformanceModeEffects(usePerformanceSettingsStore.getState());
usePerformanceSettingsStore.subscribe(syncPerformanceModeEffects);
