import React from 'react';
import { useTranslation } from 'react-i18next';
import { Row, TextField } from '../../kit';
import { useSpotifySettingsStore } from '../../../../../stores/useSpotifySettingsStore';
import { O } from './options';

// src/components/modal/settings/pages/integration/SpotifyClientIdRows.tsx
// 「自带 Spotify Client ID」那一行（连接与集成 → 服务，只在安卓画）：一个输入框，没有开关 ——
// 留空就是用内置共用客户端，填了下一次登录起用自己的。为什么值得填、去哪建应用、重定向
// 地址填什么，都写在行下的 hint 里（options.spotifyClientIdDesc），不在这儿另找地方藏。
//
// 直接读自己的 store（与「性能与动效」页读性能 store 同一个做法），不走 viewProps 那套大
// 管道：这一行没有别处要联动的状态，管道是给跨页共享的表单准备的。
export const SpotifyClientIdRows: React.FC = () => {
    const { t } = useTranslation();
    const clientId = useSpotifySettingsStore(state => state.spotifyClientId);
    const setClientId = useSpotifySettingsStore(state => state.handleSetSpotifyClientId);

    return (
        <Row option={O.spotifyClientId} hint={t('options.spotifyClientIdDesc')}>
            <TextField
                value={clientId}
                onChange={setClientId}
                placeholder={t('options.spotifyClientIdPlaceholder')}
            />
        </Row>
    );
};

export default SpotifyClientIdRows;
