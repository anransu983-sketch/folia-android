import { create } from 'zustand';
import {
    applyAndroidPhoneFit,
    readStoredAndroidPhoneFit,
    readStoredAndroidPhoneFitOrientation,
    syncAndroidPhoneFitNative,
    writeStoredAndroidPhoneFit,
    writeStoredAndroidPhoneFitOrientation,
    type AndroidPhoneFitOrientation,
} from '../services/androidPhoneLayout';

// src/stores/useAndroidLayoutSettingsStore.ts
// 「手机适配」开关。默认关闭 —— 打开后才在 <html> 上落 data-folia-phone-fit='true'，
// 由 styles/androidPhoneFit.css 接管布局；关掉时上游的桌面布局一个字节都不会变。

type AndroidLayoutSettingsState = {
    phoneFitEnabled: boolean;
    phoneFitOrientation: AndroidPhoneFitOrientation;
    setPhoneFitEnabled: (enabled: boolean) => void;
    setPhoneFitOrientation: (orientation: AndroidPhoneFitOrientation) => void;
};

export const useAndroidLayoutSettingsStore = create<AndroidLayoutSettingsState>((set, get) => ({
    phoneFitEnabled: readStoredAndroidPhoneFit(),
    phoneFitOrientation: readStoredAndroidPhoneFitOrientation(),
    setPhoneFitEnabled: (enabled) => {
        writeStoredAndroidPhoneFit(enabled);
        applyAndroidPhoneFit(enabled, get().phoneFitOrientation);
        // 原生侧同步：开关打开时顺带锁方向（见 PhoneLayoutOrientation）。
        syncAndroidPhoneFitNative(enabled, get().phoneFitOrientation);
        set({ phoneFitEnabled: enabled });
    },
    setPhoneFitOrientation: (orientation) => {
        writeStoredAndroidPhoneFitOrientation(orientation);
        /*
         * 第一个参数（手机适配总开关）恒为 false：那一行已经从设置里删了，这里不能再
         * 顺手把 `data-folia-phone-fit` 打开 —— 否则一个没有入口的开关会一直生效。
         * 方向属性照旧写，横屏那套缩放要看它。
         */
        applyAndroidPhoneFit(false, orientation);
        // 原生侧：横屏锁横屏，其它交回系统（PhoneLayoutOrientation 不再看总开关）。
        syncAndroidPhoneFitNative(true, orientation);
        set({ phoneFitOrientation: orientation });
    },
}));
