import { create } from 'zustand';
import { getStoredString, removeStoredKey, setStoredString } from './storagePrimitives';

// src/stores/useSpotifySettingsStore.ts
// 「自带 Spotify Client ID」（安卓专属，设置在「连接与集成」页）：留空用内置的共用客户端，
// 填了就用用户自己的。
//
// 存在的理由是限流桶：内置那个 client_id 是开源播放器共用的，Spotify 的限流按 client 算，
// 全网共挤一个桶的结果是登录本身成功、令牌也有效，紧接着读账号（GET /me）连吃 429，一次
// 好登录被当成失败丢掉。用户在 Spotify 开发者后台建自己的应用，限流桶就是自己的。
//
// 流程是授权码 + PKCE，没有 client secret 参与，所以这里只存 ID 一个字符串。刷新令牌是
// 发给它的那个 client 的：换了 ID（或清空回内置）之后，旧会话的 refresh 会被 Spotify 拒掉
// （invalid_grant），界面会照常提示重新登录 —— 这是预期，不是 bug。
//
// 只在安卓有意义：桌面端的登录走 electron/spotify，那边读的是它自己的配置，不看这个键；
// Web 端没有原生登录桥。原值三平台都存，取用点（spotifyNative）只在安卓登录时读。

// key 写成独立字面量常量：storeContract 的快照靠扫描源码字面量盯住改名，拼出来的 key 它看不见。
const SPOTIFY_CLIENT_ID_KEY = 'spotify_client_id';

export type SpotifySettingsState = {
    /** 用户填的 Client ID（已去首尾空白）；空字符串 = 用内置共用客户端。 */
    spotifyClientId: string;
    handleSetSpotifyClientId: (value: string) => void;
};

const normalizeClientId = (value: string): string => value.trim();

export const useSpotifySettingsStore = create<SpotifySettingsState>(set => ({
    spotifyClientId: normalizeClientId(getStoredString(SPOTIFY_CLIENT_ID_KEY, '')),

    handleSetSpotifyClientId: (value) => {
        const clientId = normalizeClientId(value);
        if (clientId) {
            setStoredString(SPOTIFY_CLIENT_ID_KEY, clientId);
        } else {
            removeStoredKey(SPOTIFY_CLIENT_ID_KEY);
        }
        set({ spotifyClientId: clientId });
    },
}));

/** 非响应式读取，给登录发起点（spotifyNative）在调用那一刻取值用。 */
export const readSpotifyClientId = (): string => (
    useSpotifySettingsStore.getState().spotifyClientId
);
