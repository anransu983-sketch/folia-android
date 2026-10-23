// public/folia-cover-sw-standalone.js
// Capacitor 打包（安卓）专用的封面 worker 壳。
//
// 本体 folia-cover-sw.js 只挂了 fetch 监听 —— 它的 install / activate（skipWaiting +
// clientsClaim）由 PWA worker 提供，vite.config.ts 用 workbox 的 importScripts 把它并进去。
// 但 VitePWA 在 isCapacitorBuild 时压根不挂（见 vite.config.ts），原生包里没有任何 worker
// 应答 /__folia_cover/，所以这里补一个自带生命周期的壳，再把本体拉进来。
//
// Web / 桌面端不要注册它：同一个 scope（'/'）只容得下一个注册，在这里注册会把 PWA worker
// 顶掉，离线预缓存就废了 —— 上游正是为此把封面路由并进 PWA worker 的。
//
// 两行监听必须在 importScripts 之前装好，否则本体的 fetch 会先于生命周期挂上。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

importScripts('folia-cover-sw.js');
