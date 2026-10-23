import { nativePlayer, type NativePlaybackEvent } from './nativePlayerPlugin';

// src/services/playbackEngine/nativePlaybackEngine.ts
//
// 原生播放内核在 Web 侧的那一半：一个进程里只有一个播放器，所以这里是单例。
//
// 时钟是这里最容易做错的地方。原生播放器**不会**给逐帧位置 —— 它每 250ms 推一次
// `position`，而歌词、进度条都是按帧读的。所以位置要按本地墙钟插值补出来：
//
//     真实位置 ≈ 最后一次上报的位置 + (现在 − 那次上报的时刻) × 倍速
//
// 绝不反过来做「Web 侧每秒调 getSnapshot 问一次」：Capacitor 的桥只有一条，
// 轮询会和批量拉取那些操作抢同一条通道（成片 cookie 超时就是这么来的）。
//
// 夹在 duration 之内：缓冲、切歌之后插出来的值可能越过结尾，
// 一首 4 分钟的歌进度条冲到 4:07 再弹回来很难看。

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * ⛔ 原生播放（P1）总闸：**已停用**。
 *
 * 只断入口，引擎代码先留着（随时能拨回来）。拨回 `true` 就恢复原来的行为，
 * 设置里那一项会跟着回来 —— 下面的开关判定和 `nativeTakes` 全都挂在它上面。
 *
 * 为什么停：用户实测「开原生播放时 App 内那个歌词可视化页面隔几秒顿一下、关掉就好」，
 * 关掉之后那套排查（120Hz 下 WebView 每秒 100 次 `syncAndDrawFrame` + 周期性
 * React 提交）不再需要背着一条额外的变量。⚠️ 但它**不是**唯一嫌疑：关掉状态下也测到过
 * `busy 335/1011, 307 msgs` 与 1 秒级的 `[FoliaHitch]`，所以别以为停用它就等于治好了。
 *
 * ⚠️ 代价：媒体缓存副本与本地歌走 `blob:`，原生吃不下、本来就回落 `<audio>`；
 * 停用之后**所有**歌都走 `<audio>` + Web Audio 图。这条路是原来就有的，
 * 只是当初做原生播放就是为了绕开它。
 */
export const NATIVE_PLAYBACK_ENABLED: boolean = false;

class NativePlaybackEngine {
    private positionMs = 0;
    private durationMs = 0;
    private playing = false;
    private hasSource = false;
    private rate = 1;
    private updatedAtMs = 0;
    /**
     * 上一次对外给过的位置（毫秒）。
     *
     * 只进不退 —— 这是「歌词往回抽一下又恢复」的直接解药：位置采样本身会滞后
     * （ExoPlayer 的位置是按音频轨道推进的，不是连续量），而暂停/缓冲这类事件又会
     * 让插值那一截凭空消失，于是给出去的值会掉回 250ms 前，再被下一帧追上。
     *
     * 但也不能无上限地只进：那样采样一慢，假领先就会一直攒下去。所以再夹一个
     * 「最多比原始采样领先 MAX_LEAD_MS」，两头一起看。
     */
    private lastDeliveredMs = 0;
    private repeatMode = 0;
    private volume = 1;
    private currentUrl: string | null = null;
    private listeners = new Set<(event: NativePlaybackEvent) => void>();
    private subscriptionStarted = false;

    /**
     * 这个地址能不能交给原生。
     *
     * `blob:` 不行 —— 那是 WebView 自己造的对象 URL（本地歌、以及**媒体缓存副本**），
     * 原生进程根本看不到它。遇到这种地址整首回落到 `<audio>`，等缓存搬进私有目录
     * （后面的阶段）再说。
     */
    supports(url: string | null | undefined): boolean {
        if (!url) return false;
        if (url.startsWith('blob:')) return false;
        if (url.startsWith('data:')) return false;
        return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('content://') || url.startsWith('file://');
    }

    /** 当前是不是由原生在播（用来决定进度条走哪条时钟）。 */
    activeUrl(): string | null {
        return this.hasSource ? this.currentUrl : null;
    }

    /** 原生手上有没有歌（不论在不在播）。进度条与歌词看这个，不看 isPlaying。 */
    ownsPlayback(): boolean {
        return this.hasSource;
    }

    isPlaying(): boolean {
        return this.hasSource && this.playing;
    }

    /**
     * 插值出来的领先最多允许多少：采样滞后时的缓冲空间，也是假领先的上限。
     *
     * ⚠️ 必须 **大于原生那边的位置过桥间隔**（`FoliaNativePlayerPlugin` 的
     * `WEB_NOTIFY_INTERVAL_MS`，500ms）：过桥降频之后，两次采样之间要靠这里插值顶着，
     * 上限比间隔还小的话位置会被夹住、进度条与歌词走走停停。多给 200ms 吃掉抖动。
     */
    private static readonly MAX_LEAD_MS = 700;

    /** 插值后的当前位置（秒）。没有源时给 0。 */
    getPositionSec(): number {
        if (!this.hasSource) return 0;
        const raw = this.playing
            ? this.positionMs + Math.max(0, performance.now() - this.updatedAtMs) * this.rate
            : this.positionMs;
        const upper = this.durationMs > 0 ? Math.min(this.positionMs + NativePlaybackEngine.MAX_LEAD_MS, this.durationMs) : this.positionMs + NativePlaybackEngine.MAX_LEAD_MS;
        // 不许往回走，也不许把假的领先越攒越多。
        const delivered = Math.min(Math.max(raw, this.lastDeliveredMs), Math.max(upper, this.positionMs));
        this.lastDeliveredMs = Math.max(0, delivered);
        return this.lastDeliveredMs / 1000;
    }

    getDurationSec(): number {
        return this.durationMs > 0 ? this.durationMs / 1000 : 0;
    }

    async setSource(url: string, options: { startPositionMs?: number | null; repeatMode?: number } = {}): Promise<void> {
        this.ensureSubscription();
        this.currentUrl = url;
        this.hasSource = true;
        this.playing = false;
        this.positionMs = options.startPositionMs ?? 0;
        this.durationMs = 0;
        this.updatedAtMs = performance.now();
        this.lastDeliveredMs = this.positionMs;
        if (typeof options.repeatMode === 'number') this.repeatMode = options.repeatMode;
        await nativePlayer.prepare({
            url,
            startPositionMs: options.startPositionMs ?? null,
            repeatMode: this.repeatMode,
        });
        await nativePlayer.setVolume(this.volume);
    }

    async play(): Promise<void> {
        await nativePlayer.play();
        // 播放意图先记下：等 `playing` 事件回来之前，进度条不该停在原地不动。
        this.playing = true;
        this.updatedAtMs = performance.now();
    }

    async pause(): Promise<void> {
        await nativePlayer.pause();
        this.playing = false;
    }

    async seek(seconds: number): Promise<void> {
        const targetMs = Math.max(0, Math.round(seconds * 1000));
        this.positionMs = targetMs;
        this.updatedAtMs = performance.now();
        // 跳是唯一允许「往回走」的动作，所以这里必须把只进不退的基准一起复位。
        this.lastDeliveredMs = targetMs;
        await nativePlayer.seek(targetMs);
    }

    async stop(): Promise<void> {
        this.hasSource = false;
        this.playing = false;
        this.positionMs = 0;
        this.durationMs = 0;
        this.lastDeliveredMs = 0;
        this.currentUrl = null;
        await nativePlayer.stop();
    }

    setVolume(volume: number): void {
        this.volume = clamp(volume, 0, 1);
        if (!this.hasSource) return;
        void nativePlayer.setVolume(this.volume).catch(() => undefined);
    }

    setSpeed(speed: number): void {
        this.rate = clamp(speed, 0.1, 4);
        if (!this.hasSource) return;
        void nativePlayer.setSpeed(this.rate).catch(() => undefined);
    }

    setRepeatMode(repeatMode: number): void {
        // 只记下来：下一次 prepare 会带上它。已经在播的这一首不重新装地址 —— 那会把
        // 当前这一首从头再来一遍，而「单曲循环」是随时能按的。
        this.repeatMode = repeatMode;
    }

    subscribe(listener: (event: NativePlaybackEvent) => void): () => void {
        this.listeners.add(listener);
        this.ensureSubscription();
        return () => {
            this.listeners.delete(listener);
        };
    }

    private ensureSubscription(): void {
        if (this.subscriptionStarted) return;
        this.subscriptionStarted = true;
        void nativePlayer.addListener(event => {
            this.apply(event);
            this.listeners.forEach(listener => listener(event));
        }).catch(() => undefined);
    }

    private apply(event: NativePlaybackEvent): void {
        const now = performance.now();
        if (typeof event.positionMs === 'number') {
            this.positionMs = Math.max(0, event.positionMs);
            this.updatedAtMs = now;
        }
        if (typeof event.durationMs === 'number' && event.durationMs > 0) {
            this.durationMs = event.durationMs;
        }
        switch (event.type) {
            case 'playing':
                this.playing = true;
                this.updatedAtMs = now;
                break;
            case 'paused':
            case 'ended':
            case 'error':
            case 'idle':
                this.playing = false;
                break;
            case 'buffering':
                /*
                 * 缓冲期间播放器的 `isPlaying` 会翻成 false（ExoPlayer 的语义：没在出声）。
                 * 但歌并没有停 —— 这里要是跟着置 false，进度条就停在原地、歌词不动，
                 * 等缓冲结束再猛地跳一段，看着就是「一直抽搐」。所以缓冲不改这个标记：
                 * 位置上报送着（缓冲时它本来不前进），插值也就不会跑飞。
                 */
                break;
            default:
                break;
        }
    }
}

export const nativePlaybackEngine = new NativePlaybackEngine();
