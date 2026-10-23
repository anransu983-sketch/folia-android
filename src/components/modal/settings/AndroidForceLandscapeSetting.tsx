import React from 'react';
import { Row, Toggle } from './kit';
import { useAndroidLayoutSettingsStore } from '../../../stores/useAndroidLayoutSettingsStore';
import { O } from './pages/appearance/options';

// src/components/modal/settings/AndroidForceLandscapeSetting.tsx
// 安卓独占的「强制横屏」：打开就把 Activity 锁成横屏，关掉交回系统跟着传感器转。
//
// 它替掉了原来那两行（「手机适配」总开关 + 底下那行「横竖屏兼容」）：
// 总开关按用户要求删了 —— 打开也不生效；而底下那行被它门着，单独打开更是毫无反应
// （原生那道 `isEnabled()` 门已随它一起去掉，见 PhoneLayoutOrientation）。
// 于是这一行现在**自己就是一个完整的开关**，不再依赖任何前置项。
//
// 行由 kit 的 Row 画：标签与说明都取自 `O.forceLandscape` 那一条声明
// （labelKey / noteKey），说明不再铺在标签底下，而是收进「i」。

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

const AndroidForceLandscapeSetting: React.FC = () => {
    const orientation = useAndroidLayoutSettingsStore(state => state.phoneFitOrientation);
    const setOrientation = useAndroidLayoutSettingsStore(state => state.setPhoneFitOrientation);

    if (!isAndroidNativeRuntime()) return null;

    return (
        <Row option={O.forceLandscape}>
            <Toggle
                checked={orientation === 'landscape'}
                onChange={() => setOrientation(orientation === 'landscape' ? 'portrait' : 'landscape')}
            />
        </Row>
    );
};

export default AndroidForceLandscapeSetting;
