import { useEffect } from 'react';
import { setNativeImmersive } from '../platform/foliaNative';
import { isCapacitorAndroid } from '../platform/runtime';
import type { AppView } from '../stores/useAppViewStore';

// src/hooks/useImmersiveLyricsBars.ts
// 系统栏的可见性跟视图走：**只有可视化歌词页面隐藏系统栏，其余页面一律显示。**
//
// 以前是一进 App 就全沉浸（状态栏 + 导航栏都藏起来），可除了歌词页之外，用户其实一直
// 想看见时间 / 电量 / 通知图标 —— 在首页翻两页完全看不到状态栏是纯亏。现在默认显示，
// 由这里按当前视图明确告知原生。
//
// 为什么判定放在 Web 层：原生只知道有一个 WebView，分不清哪个页面算「歌词页」；
// 而视图状态本来就在 useAppViewStore 里，读它最准。原生侧（MainActivity.applyImmersiveMode）
// 只负责执行这个已经算好的结论。
export const useImmersiveLyricsBars = (currentView: AppView | null | undefined): void => {
    useEffect(() => {
        if (!isCapacitorAndroid()) return;
        void setNativeImmersive(currentView === 'player');
    }, [currentView]);
};
