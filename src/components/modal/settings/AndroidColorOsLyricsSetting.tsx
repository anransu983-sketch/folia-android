import React, { useEffect, useState } from 'react';
import { Row, Toggle } from './kit';
import { getColorOsLyricsSupport, type ColorOsLyricsSupport } from '../../../platform/foliaColorOsLyrics';
import { useColorOsLyricsStore } from '../../../stores/useColorOsLyricsStore';
import { O } from './pages/integration/options';

// src/components/modal/settings/AndroidColorOsLyricsSetting.tsx
// ColorOS 原生锁屏 / 息屏歌词（C16 = ColorOS 16+）的开关，fork 独有。
//
// 上游把设置子页重写成 pages/* 时，原来挂着它的 IntegrationSettingsSubview 被删了，
// 于是「设置里根本找不到这一项」—— 运行时链路（App.tsx 的 useColorOsLyricFeed、
// MainActivity 里的插件注册）全都还在，只是没有入口。这里把开关补回来（挂在
// 「连接与集成」页的系统歌词组）。
//
// 这一项**只在探测为 ColorOS 16+ 时才出现**：不是那台机器，这条通道就压根不存在，
// 连一张「未启用」的卡都不该占着位置 —— 以前是安卓就显示，非 C16 的机器上摆一张
// 「未启用」的卡，看着像个坏掉的开关。探测是异步的，出结果之前同样不渲染。
//
// 能不能用由 ROM 说了算（原生探测），用不用由用户说了算（这个开关，默认开）。

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

export const AndroidColorOsLyricsSetting: React.FC = () => {
    const [support, setSupport] = useState<ColorOsLyricsSupport | null>(null);
    const enabled = useColorOsLyricsStore(state => state.enabled);
    const setEnabled = useColorOsLyricsStore(state => state.setEnabled);

    // 探测是一次异步的原生调用，结果留在本组件里：设置页每次打开都重新问一次，
    // 免得显示的是上一次启动时的旧结论。
    useEffect(() => {
        if (!isAndroidNativeRuntime()) return undefined;
        let alive = true;
        void getColorOsLyricsSupport().then(result => {
            if (alive) setSupport(result);
        }).catch(() => {
            if (alive) setSupport(null);
        });
        return () => { alive = false; };
    }, []);

    if (!isAndroidNativeRuntime()) return null;
    if (!support?.supported) return null;

    return (
        // 行由 kit 的 Row 画：标签与说明都取自 `O.colorOsLyrics` 那条声明
        // （labelKey / noteKey），说明不再铺在标签底下，而是收进「i」。
        // below 里那行小字是唯一的探测证据（到底把这台机器认成 ColorOS 几），留着。
        <Row
            option={O.colorOsLyrics}
            below={support.colorOsMajor > 0 ? (
                <span className="text-[11px] tabular-nums text-[color:var(--st-t3)]">
                    ColorOS {support.colorOsMajor}
                </span>
            ) : undefined}
        >
            <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
        </Row>
    );
};

export default AndroidColorOsLyricsSetting;
