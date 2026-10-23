import { isLocalCoverWebRuntimeSupported } from './localCoverBinaryStore';
import { migrateLegacyLocalCoverAssetsInBackground } from './localCoverAssetService';
import { isLocalCoverAssetUrl } from './localCoverAssetUrl';
import { isCapacitorAndroid } from '../platform/runtime';

// src/services/localCoverRuntime.ts
// Re-requests local covers that failed before the Web resource route served them, then starts resumable legacy migration.

// Re-assigns the src of every rendered local cover that has not decoded, so the browser requests it again.
const retryBrokenLocalCoverImages = (): void => {
  document.querySelectorAll<HTMLImageElement>('img').forEach(image => {
    const source = image.getAttribute('src');
    if (!isLocalCoverAssetUrl(source) || image.naturalWidth > 0) return;
    image.removeAttribute('src');
    queueMicrotask(() => {
      if (image.isConnected) image.src = source;
    });
  });
};

// Capacitor 打包（安卓）要注册的壳：自带 install / activate，再 importScripts 拉进本体。
// 见 public/folia-cover-sw-standalone.js 文件头的说明。
const STANDALONE_WORKER_URL = '/folia-cover-sw-standalone.js';

/**
 * 启动本地封面运行时 —— **不阻塞启动**，返回 void。
 *
 * 封面路由 `/__folia_cover/` 跑在 `public/folia-cover-sw.js` 里。这个文件只挂了 fetch 监听，
 * 生命周期（skipWaiting / clientsClaim）归 PWA worker：vite.config.ts 用 workbox 的
 * importScripts 把它并进 PWA worker。所以 Web / 桌面端**绝不能**自己注册它 ——
 * 同一个 scope（'/'）只容得下一个注册，在这里注册会把 PWA worker 顶掉，离线预缓存全废。
 *
 * **Capacitor 打包是唯一的例外**：vite.config.ts 里 VitePWA 是
 * `...(isCapacitorBuild ? [] : [VitePWA({...})])`，原生包根本不挂 PWA 插件，
 * 于是这条路由在安卓上没有任何 worker 应答，本地封面会全部取不到。
 * 所以原生运行时注册一个自带生命周期的壳（`folia-cover-sw-standalone.js`），
 * Web / 桌面端什么都不注册。
 *
 * 启动不等 worker：worker 接管页面后 `controllerchange` 会把这一期间失败的封面重新要一次，
 * 第二次打开起 worker 已经是 active 状态，封面直接命中。
 */
export const initializeLocalCoverRuntime = (): void => {
  if (isLocalCoverWebRuntimeSupported() && 'serviceWorker' in navigator) {
    // 新 worker 接管时把这一期间请求失败的那批封面重新要一次。
    navigator.serviceWorker.addEventListener('controllerchange', retryBrokenLocalCoverImages);
    if (isCapacitorAndroid()) {
      void (async () => {
        try {
          await navigator.serviceWorker.register(STANDALONE_WORKER_URL, { scope: '/' });
        } catch (error) {
          console.error('[LocalCoverAsset] Failed to initialize the local cover service worker', error);
        }
      })();
    }
  }

  // Retry only covers that failed before their legacy payload reached external storage.
  void migrateLegacyLocalCoverAssetsInBackground().then(retryBrokenLocalCoverImages);
};
