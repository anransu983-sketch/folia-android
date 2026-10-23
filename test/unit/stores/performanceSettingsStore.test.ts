import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    readPerformanceMode,
    resolvePerformanceMode,
    usePerformanceSettingsStore,
} from '@/stores/usePerformanceSettingsStore';

// test/unit/stores/performanceSettingsStore.test.ts
// 性能模式默认关（观感优先），开关原值存 performance_mode；效果点一律过平台门控，
// 单测环境不是安卓 App，所以 resolve/read 永远是 false —— 桌面与 Web 拿到存下的值也不生效。

describe('performance settings store', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        usePerformanceSettingsStore.setState({ performanceMode: false });
    });

    afterEach(() => {
        usePerformanceSettingsStore.setState({ performanceMode: false });
        vi.unstubAllGlobals();
    });

    it('defaults to off when nothing is stored', async () => {
        vi.resetModules();
        const fresh = await import('@/stores/usePerformanceSettingsStore');
        expect(fresh.usePerformanceSettingsStore.getState().performanceMode).toBe(false);
    });

    it('restores the stored choice on load', async () => {
        values.set('performance_mode', 'true');
        vi.resetModules();
        const fresh = await import('@/stores/usePerformanceSettingsStore');
        expect(fresh.usePerformanceSettingsStore.getState().performanceMode).toBe(true);
    });

    it('persists the toggle under its own key', () => {
        usePerformanceSettingsStore.getState().handleTogglePerformanceMode(true);
        expect(usePerformanceSettingsStore.getState().performanceMode).toBe(true);
        expect(values.get('performance_mode')).toBe('true');

        usePerformanceSettingsStore.getState().handleTogglePerformanceMode(false);
        expect(usePerformanceSettingsStore.getState().performanceMode).toBe(false);
        expect(values.get('performance_mode')).toBe('false');
    });

    it('never resolves to effective outside the Android app, whatever the stored switch says', () => {
        usePerformanceSettingsStore.setState({ performanceMode: true });
        expect(resolvePerformanceMode(usePerformanceSettingsStore.getState())).toBe(false);
        expect(readPerformanceMode()).toBe(false);
    });
});
