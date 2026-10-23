import React from 'react';
import { useTranslation } from 'react-i18next';
import { Row, Toggle } from './kit';
import { useLyriconStore } from '../../../stores/useLyriconStore';
import { O } from './pages/integration/options';

// src/components/modal/settings/AndroidLyriconSetting.tsx
// Android-only 状态栏歌词（Lyricon）开关。
//
// 上游把设置页重写成 pages/* 那一套时，原来挂着这个开关的 IntegrationSettingsSubview 被删了，
// 于是 useLyriconStore.handleToggleLyricon 一个调用方都不剩 —— 运行时链路（useLyriconFeed、
// 原生插件注册）全都还在，只是**再也打不开**：老用户存着的 folia.lyriconEnabled=true 照常工作，
// 新用户永远开不了，界面也不报错。这里把开关补回来（挂在「连接与集成」页的系统歌词组）。
//
// 行由 kit 的 Row 画：标签与说明都取自 `O.lyricon` 那条声明（labelKey / noteKey）。
// 唯一还留在行上的是「开了却连不上」那句 —— 它是状态告警，不是说明，藏进「i」里就变成了
// 界面显示「已开启」而状态栏什么都没有。

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

const AndroidLyriconSetting: React.FC = () => {
    const { t } = useTranslation();
    const enabled = useLyriconStore(state => state.enabled);
    const connected = useLyriconStore(state => state.connected);
    const setEnabled = useLyriconStore(state => state.handleToggleLyricon);

    if (!isAndroidNativeRuntime()) return null;

    return (
        <Row
            option={O.lyricon}
            hint={enabled && !connected ? t('options.lyriconNotConnectedDesc') : undefined}
        >
            <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
        </Row>
    );
};

export default AndroidLyriconSetting;
