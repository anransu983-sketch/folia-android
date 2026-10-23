import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// src/stores/useColorOsLyricsStore.ts
// ColorOS 原生锁屏 / 息屏歌词（C16 = ColorOS 16+）的开关。
//
// 与状态栏歌词（Lyricon）那条路不同，这条通道**不需要任何第三方 App** —— ColorOS SystemUI
// 自己认 MediaMetadata["lyricInfo"]。所以「能不能用」只取决于 ROM 是不是 C16+，这一点由原生
// 探测说了算（platform/foliaColorOsLyrics.getColorOsLyricsSupport），界面上不提供强行打开。
//
// 但「用不用」是用户的事：锁屏上一直挂着一行歌词不是所有人都想要，所以给一个开关。
// **默认开** —— 探测到 C16+ 就自动生效，不需要用户先找到这一项才知道有这个功能；
// 不想要的人自己关掉（useColorOsLyricFeed 尊重它，关掉时会把锁屏上那行词撤掉）。
//
// 开关落在 localStorage：它是个用户偏好，跟账号无关，也不该每次启动被重置。

const COLOR_OS_LYRICS_ENABLED_KEY = 'folia.colorOsLyricsEnabled';

type ColorOsLyricsState = {
    enabled: boolean;
    setEnabled: (enable: boolean) => void;
};

export const useColorOsLyricsStore = create<ColorOsLyricsState>((set) => ({
    enabled: getStoredBoolean(COLOR_OS_LYRICS_ENABLED_KEY, true),
    setEnabled: (enable) => {
        setStoredBoolean(COLOR_OS_LYRICS_ENABLED_KEY, enable);
        set({ enabled: enable });
    },
}));
