import React from 'react';
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../platform/runtime';
import type { SongResult } from '../types';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../services/onlineMusic/songMetadata';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { fetchCoverBytes } from '../services/coverBytes';
import { nativePlaybackEngine } from '../services/playbackEngine/nativePlaybackEngine';

// 当前文件：把播放状态与元数据送到原生前台服务，换取通知栏媒体控制与后台网络保活。

/**
 * 与 FoliaPlaybackService / MainActivity 里的常量一一对应，改一处必须两处都改。
 */
const ACTION_UPDATE_METADATA = 'top.izuna.foliamajor.action.UPDATE_METADATA';
const ACTION_UPDATE_STATE = 'top.izuna.foliamajor.action.UPDATE_STATE';
const ACTION_STOP_FOREGROUND = 'top.izuna.foliamajor.action.STOP_FOREGROUND';
const ACTION_WEB_COMMAND = 'top.izuna.foliamajor.action.WEB_COMMAND';
const EXTRA_COMMAND = 'command';

type PlaybackSnapshot = 'playing' | 'paused' | 'stopped';

interface FoliaPlaybackPlugin {
  /** 启动前台服务并更新媒体元数据。artworkBase64 传 null 表示这次没有新封面。 */
  update(options: {
    title?: string;
    artist?: string;
    album?: string;
    artworkBase64?: string | null;
    /** 封面地址。原生会自己下载，用来绕开 WebView 的 CORS 限制。 */
    artworkUrl?: string | null;
    durationMs?: number;
    /** 通知栏封面角标用哪颗图标（当前播放来源的平台，本地等自家人传 'folia'）。 */
    providerBadge?: string | null;
    /**
     * 当前这首歌的身份。
     *
     * 原生拿它跟上一首比：不一样就是换歌了，先把上一首的封面丢掉。没有它就分不清
     * 「这首歌没有封面」和「还没拿到封面」——后一种情况下旧封面会被一直挂着，
     * 通知栏于是先画出上一首的图，等原生按 URL 下载完才换成当前的。
     */
    songKey?: string | null;
    /**
     * 这首歌是不是「已喜欢」：通知栏那颗心画实心还是空心就看它。
     * 不传 = 这次不改（原生保留上一个值）。
     */
    liked?: boolean | null;
    /**
     * 「喜欢」这个动作现在能不能用。false 时通知栏干脆不画那颗心 —— 通知按钮没有置灰，
     * 画出来点了没反应比不画更让人困惑。不传 = 这次不改。
     */
    canLike?: boolean | null;
  }): Promise<void>;
  /** 更新播放状态。playing=true 时服务会真正进入前台。 */
  setState(options: {
    state: PlaybackSnapshot;
    positionMs?: number;
    speed?: number;
  }): Promise<void>;
  /** 停止播放时收掉前台服务与通知。 */
  stop(): Promise<void>;
  /** 原生在用户点击通知栏/锁屏/耳机按键时派发的事件。 */
  addListener(
    eventName: 'foliaPlaybackCommand',
    listener: (payload: { command: string; positionMs?: number }) => void,
  ): Promise<() => void>;
}

const FoliaPlayback = registerPlugin<FoliaPlaybackPlugin>('FoliaPlayback');

// 通知栏封面：Base64 体积大，同一首歌只取一次。
const artworkCache = new Map<string, string>();
const ARTWORK_MAX_EDGE = 512;

/**
 * 把封面图片抓成 base64。
 *
 * 通知栏需要 Bitmap 而非 URL：通知由系统进程渲染，它无法访问 WebView 的
 * 缓存文件或带鉴权的资源。用 canvas 缩到 512px 再编码，避免大图撑爆 Binder 事务
 * （跨进程传输有 1MB 上限，传原始大图会 TransactionTooLargeException）。
 */
const loadArtworkAsBase64 = async (url: string): Promise<string | null> => {
  const cached = artworkCache.get(url);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;

  try {
    // 取字节这件事只有 services/coverBytes 那一处知道该怎么取：
    // 带凭据的那一跳会让「回通配符」的图床直接被浏览器判死，通知栏于是常年没有封面。
    const blob = await fetchCoverBytes(url);
    if (!blob) return null;
    if (typeof createImageBitmap !== 'function') return null;

    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, ARTWORK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    // data URL 本身带前缀，原生侧会剥掉，这里原样传。
    artworkCache.set(url, dataUrl);
    // 只缓存最近的几张，避免长时间播放把内存吃满。
    if (artworkCache.size > 8) {
      const oldest = artworkCache.keys().next().value;
      if (oldest !== undefined) artworkCache.delete(oldest);
    }
    return dataUrl;
  } catch {
    // 封面拿不到不影响播放与通知，原生侧会退回默认图标。
    return null;
  }
};

/**
 * 通知栏进度条的位置刷新间隔。
 *
 * 系统按 PlaybackState 里的 position 自己往前推，但那只在速度恒定时准；
 * 缓冲、跳转、换源之后它会停在错的地方，所以这里定期校准一次。
 */
const POSITION_TICK_MS = 1000;

type UseCapacitorPlaybackBridgeOptions = {
  currentSong: SongResult | null;
  cachedCoverUrl: string | null;
  playerState: string;
  mediaSessionPlayRef: React.RefObject<() => Promise<void>>;
  mediaSessionPauseRef: React.RefObject<() => void>;
  mediaSessionPrevRef: React.RefObject<() => void>;
  mediaSessionNextRef: React.RefObject<() => Promise<void> | void>;
  /** 读当前播放时间（秒），用来让通知栏那条进度条真的往前走。 */
  getCurrentTime?: () => number;
  /** 用户拖动通知栏进度条后回传的目标位置（秒）。 */
  onSeek?: (seconds: number) => void;
  /** 当前这首歌是不是「已喜欢」：通知栏那颗心的形状跟它走。 */
  isLiked?: boolean;
  /** 「喜欢」现在能不能用；false 时通知栏不画那颗心。 */
  canLike?: boolean;
  /** 通知栏 / 锁屏 / 耳机那颗心被按下。与面板里的喜爱按钮同一个动作。 */
  onToggleLike?: () => void;
};

/**
 * 把播放状态接到原生前台服务。
 *
 * 只在 Capacitor Android 下生效；Web 端与 Electron 继续用已有的
 * navigator.mediaSession 路径（见 useMediaSessionBridge）。
 */
export const useCapacitorPlaybackBridge = ({
  currentSong,
  cachedCoverUrl,
  playerState,
  mediaSessionPlayRef,
  mediaSessionPauseRef,
  mediaSessionPrevRef,
  mediaSessionNextRef,
  getCurrentTime,
  onSeek,
  isLiked = false,
  canLike = false,
  onToggleLike,
}: UseCapacitorPlaybackBridgeOptions): void => {
  const enabled = isCapacitorAndroid();

  // 这三个回调是每次渲染都可能换身份的内联函数，进 effect 依赖会把订阅反复重建。
  const callbacksRef = React.useRef({ getCurrentTime, onSeek, onToggleLike });
  callbacksRef.current = { getCurrentTime, onSeek, onToggleLike };

  // 通知栏/锁屏/耳机的控制键走这里回到 Web 层。
  React.useEffect(() => {
    if (!enabled) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void FoliaPlayback.addListener('foliaPlaybackCommand', ({ command, positionMs }) => {
      switch (command) {
        case 'play':
          void mediaSessionPlayRef.current?.();
          break;
        case 'pause':
          mediaSessionPauseRef.current?.();
          break;
        case 'next':
          void mediaSessionNextRef.current?.();
          break;
        case 'previous':
          mediaSessionPrevRef.current?.();
          break;
        case 'stop':
          mediaSessionPauseRef.current?.();
          break;
        case 'seek':
          // 拖动通知栏进度条。原生只在 actions 里带了 ACTION_SEEK_TO 时才派发这个。
          callbacksRef.current.onSeek?.(Math.max(0, (positionMs ?? 0) / 1000));
          break;
        case 'like':
          // 通知栏 / 锁屏 / 耳机那颗心。与面板里的喜爱按钮走同一个 handleLike：
          // 能不能用、成功与否、状态怎么存都归 Web 层那一份判断，原生不自己记账。
          // 状态变了会随下一次元数据推送回到通知栏，那颗心自己换形状。
          callbacksRef.current.onToggleLike?.();
          break;
      }
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [enabled, mediaSessionPlayRef, mediaSessionPauseRef, mediaSessionPrevRef, mediaSessionNextRef]);

  // 元数据：切歌时更新一次。
  React.useEffect(() => {
    if (!enabled) return;
    if (!currentSong) {
      void FoliaPlayback.stop();
      return;
    }
    const coverUrl = cachedCoverUrl || getSongCoverUrl(currentSong) || '';
    const songKey = getPlaybackSongKey(currentSong);
    const metadata = {
      title: currentSong.name || '',
      artist: getSongArtistLabel(currentSong) || '',
      album: getSongAlbumLabel(currentSong) || '',
      // 封面地址一并给过去：WebView 里 fetch 远端封面常被 CORS 挡掉，
      // 原生下载没有这个限制，通知栏因此总能拿到对应的封面。
      artworkUrl: coverUrl || null,
      durationMs: getDurationMs(currentSong),
      providerBadge: resolveProviderBadge(currentSong),
      songKey,
      liked: isLiked,
      canLike,
    };

    // 分两次发：先不带封面发一次，让原生立刻换标题并把上一首的封面丢掉，再等封面抓到补一次。
    //
    // 合成一次（等 base64 拿到再发）的话，封面抓取的这一段时间里原生手上的还是上一首的图，
    // 通知栏就先画出上一首的封面，等下载线程跑完才换成当前歌 —— 看着就是封面慢了一拍。
    let cancelled = false;
    void (async () => {
      await FoliaPlayback.update({ ...metadata, artworkBase64: null });
      if (!coverUrl) return;
      const artworkBase64 = await loadArtworkAsBase64(coverUrl);
      // 抓封面期间可能已经切歌了，晚到的这张不能贴到新歌上。
      if (cancelled || !artworkBase64) return;
      await FoliaPlayback.update({ ...metadata, artworkBase64 });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, currentSong, cachedCoverUrl, isLiked, canLike]);

  // 播放状态：playing 时服务进入前台，这是后台网络不被节流的关键。
  //
  // 位置必须真的传过去。原先这里写死 positionMs: 0，通知栏那条进度条于是永远停在
  // 开头 —— 看不出在播，更谈不上拖。播放中每秒校准一次：系统按 PlaybackState 自带
  // 的速度往前推，但缓冲、跳转、换源之后它会停在错的地方。
  React.useEffect(() => {
    if (!enabled) return;
    const state: PlaybackSnapshot = playerState === 'PLAYING'
      ? 'playing'
      : playerState === 'PAUSED'
        ? 'paused'
        : 'stopped';
    const push = () => {
      const seconds = callbacksRef.current.getCurrentTime?.() ?? 0;
      void FoliaPlayback.setState({
        state,
        positionMs: Math.max(0, Math.round(seconds * 1000)),
        speed: 1,
      });
    };
    /*
     * 只有**播放 / 暂停翻转**和挂载时推一次状态。位置那一拍下面单独判断。
     */
    push();
    if (state !== 'playing') return;
    /*
     * ⭐ 位置那一拍：**原生播放器接管的那一首一次都不推。**
     *
     * 掉帧打点量出来的是「每秒一次、每次 80~290ms」的主线程阻塞，而这里正好是
     * 每秒一次 —— 每一笔都是一次 `startService` 的 IPC，服务的 `onStartCommand`
     * **跑在 App 的主线程上**，里面还要 `mediaSession.setPlaybackState()`（同步
     * Binder 给 system_server 与所有 MediaController）。掉帧那一刻堆内存纹丝不动
     * （28MB 恒定），所以不是 GC，就是主线程在等这次跨进程调用。
     *
     * 而这一推在原生播放时**没有任何收益**：服务那边 `resolvePlaybackPositionMs()`
     * 在原生在播时直接问播放器，写进去的 `cachedPositionMs` 在那条分支上不参与
     * 计算（全服务只有一处读取，就是它的兜底分支）。后台节流那个顾虑同样不成立 ——
     * 它跑在原生侧，不吃 WebView 的定时器节流。
     *
     * ⚠️ 只挡**位置**：播放 / 暂停翻转靠上面那次 `push()`（effect 依赖 playerState），
     * 服务要认状态，那条不能省。
     */
    const timer = window.setInterval(() => {
      if (nativePlaybackEngine.ownsPlayback()) return;
      push();
    }, POSITION_TICK_MS);
    /*
     * 再补一条由播放器事件驱动的：**后台的定时器会被 Chromium 节流**（页面既不可见、
     * WebView 里又已经没有音频在响，会掉进「intensive throttling」，1 秒变 1 分钟）。
     * 靠上面那个 setInterval 推位置，通知栏在后台上就永远是同一个数字。
     * 播放器每 250ms 会推一次位置过来，那是桥事件、不吃定时器节流 —— 用它来驱动这一拍。
     * 合并成 500ms 一次，别为了进度条把桥刷满。
     *
     * ⚠️ 但**只在网页播放（`<audio>`）时**才真的推 —— 原生接管的那一首服务自己会问
     * 播放器，这一推纯属浪费（见下面 `ownsPlayback()` 那一处的说明）。
     */
    let lastPushAt = 0;
    const stopFollowingEngine = nativePlaybackEngine.subscribe(() => {
        /*
         * ⭐ **原生播放器接管的那一首，这一路一次都不推。**
         *
         * 服务那边 `FoliaPlaybackService.resolvePlaybackPositionMs()` 在原生在播时
         * **直接问播放器**（`FoliaNativePlayerPlugin.currentPositionMs()`）：比这里
         * 插值出来的更准，而且它跑在原生侧，**根本不吃 WebView 的定时器节流** ——
         * 上面那条注释担心的「后台通知栏不动」，靠的就是它，不需要 Web 顶这一下。
         * 也就是说这一推对进度条没有任何贡献（写进去的 cachedPositionMs 在原生在播
         * 时压根不参与计算），只有代价：
         *   · 一次 `startService` 的 IPC，服务 `onStartCommand` 还要重建一次
         *     MediaSession 的 PlaybackState（跨进程广播给系统 UI / 蓝牙 / Auto）；
         *   · 而 **Capacitor 的桥只有一条** —— 500ms 一笔正好把界面定期顶一下，
         *     表现就是「App 里隔一会儿顿一下，像在等什么东西」。
         *
         * 网页播放（`<audio>`）时不走这里，那条路只有播放器自己知道位置，照旧推。
         *
         * ⚠️ 只挡**位置**这一路：播放 / 暂停翻转是上面那个 effect 推的（依赖
         * playerState），服务要靠它认状态，那条不能省。
         */
        if (nativePlaybackEngine.ownsPlayback()) return;
        const now = Date.now();
        if (now - lastPushAt < 500) return;
        lastPushAt = now;
        push();
    });
    return () => {
        window.clearInterval(timer);
        stopFollowingEngine();
    };
  }, [enabled, playerState, currentSong]);
};

const getDurationMs = (song: SongResult): number => {
  const candidate = (song as SongResult & { duration?: number; durationMs?: number });
  const ms = candidate.durationMs ?? candidate.duration;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 0;
  // 有些音源给的是秒。
  return ms > 0 && ms < 1000 ? Math.round(ms * 1000) : Math.round(ms);
};

/**
 * 通知栏封面角标用哪颗图标。
 *
 * 通知栏封面右下角原本画的是 `android.R.drawable.ic_media_play`（那个 ▶），
 * 现在换成「这首歌来自哪个平台」的应用图标。来源只在在线歌的 sourceRef 上有，
 * 本地 / Navidrome / 舞台这些自家人一律回落 'folia' —— 原生侧没登记的值也回落 Folia。
 */
export const resolveProviderBadge = (song: SongResult | null | undefined): string => {
  const sourceRef = song?.sourceRef;
  if (sourceRef?.kind === 'online' && sourceRef.providerId) return sourceRef.providerId;
  return 'folia';
};

export { ACTION_UPDATE_METADATA, ACTION_UPDATE_STATE, ACTION_STOP_FOREGROUND, ACTION_WEB_COMMAND, EXTRA_COMMAND };
