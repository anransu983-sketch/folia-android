import React from 'react';
import { Row, Toggle } from './kit';
import { useScreenAwakeSettingsStore } from '../../../stores/useScreenAwakeSettingsStore';
import { O } from './pages/general/options';

// src/components/modal/settings/AndroidScreenAwakeSetting.tsx
// Android-only 屏幕常亮 switch. It lives in the interface settings because it is a device behaviour
// rather than a playback one; the playback subview keeps its narrower "only while playing" variant.
//
// 行由 kit 的 Row 画：标签与说明都取自 `O.keepScreenAwake` 那一条声明（labelKey / noteKey），
// 说明不再铺在标签底下，而是收进「i」。行上带 option 的 id，搜索结果点进来才落得到这一行。

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

const AndroidScreenAwakeSetting: React.FC = () => {
    const enabled = useScreenAwakeSettingsStore(state => state.keepScreenAwake);
    const setEnabled = useScreenAwakeSettingsStore(state => state.setKeepScreenAwake);

    if (!isAndroidNativeRuntime()) return null;

    return (
        <Row option={O.keepScreenAwake}>
            <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
        </Row>
    );
};

export default AndroidScreenAwakeSetting;
