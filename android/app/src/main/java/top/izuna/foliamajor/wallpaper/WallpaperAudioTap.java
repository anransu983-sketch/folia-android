package top.izuna.foliamajor.wallpaper;

import android.media.audiofx.Visualizer;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;

/**
 * 叠层的音频采集。
 *
 * 为什么需要它：叠层是一个**独立的 WebView**，而播放的音频在主应用的 WebView 里
 * （`usePlaybackAudioBridge` 的 `createMediaElementSource` + `createAnalyser`）。
 * 叠层拿不到那个 AnalyserNode，band 全是 0，画面就只剩静态那点呼吸。
 *
 * 更要紧的是：**也不能把主应用采到的频谱经桥转过来**。采它的那个 rAF 跑在主应用
 *
 * 输出刻意做成**和 Web 侧同一套量纲**，好让叠层画出来的形状和播放页一致：
 * 5 个 band 走 `usePlaybackVisualizerBridge` 里同一组频率边界、同一条 shape 曲线。
 *
 * 曾经还有一份 128 段的频谱数组跟着一起推（叠层上莫奈底部那条「音频图案」画它），
 * 那条已于 2026-10-24 连同它的两个设置一起删掉：每秒二十次传一份没人读的数组，
 * 白白给叠层的 WebView 主线程加活。band 才是叠层现在唯一吃的东西。
 *
 * 拿不到数据时静默降级：一帧都不推，叠层维持它原来的行为。
 * 会拿不到的情况有几种：manifest 缺 MODIFY_AUDIO_SETTINGS、别的进程已经占用了
 * session 0 的 Visualizer、以及蓝牙 A2DP 输出（系统明确不给数据）。
 */
public final class WallpaperAudioTap {

    private static final String TAG = "FoliaWallpaperAudioTap";

    /** 采集节拍（次/秒）。下面按 Visualizer 要求的毫赫兹换算。 */
    private static final int CAPTURE_FPS = 20;

    /** 幅度上的指数平滑，对齐 AnalyserNode 的 smoothingTimeConstant = 0.6。 */
    private static final double SMOOTHING = 0.6;

    /** 幅度 → 0..255 的参考响度。
     *
     * Visualizer 给的是**线性幅度**（signed byte 尺度，hypot 之后约 0..181），
     * 而页面那侧吃的是 dB 域。两边差一个固定尺度因子，这里用一个常量把它对上。
     *
     * **真机校准点**：频谱一直贴顶就把这个值调大，一直趴着就调小。
     */
    private static final double DB_REFERENCE = 84.0;

    /** 与 Web Audio 的 minDecibels(-100) / maxDecibels(-30) 一致。 */
    private static final double DB_RANGE = 70.0;

    /** 采集的一声。数值全部是 0..255，跟页面侧 motion value 的量纲一致。 */
    public static final class Frame {
        public final int power;
        public final int bass;
        public final int lowMid;
        public final int mid;
        public final int vocal;
        public final int treble;

        Frame(int power, int bass, int lowMid, int mid, int vocal, int treble) {
            this.power = power;
            this.bass = bass;
            this.lowMid = lowMid;
            this.mid = mid;
            this.vocal = vocal;
            this.treble = treble;
        }
    }

    /** 采样结果的上送。跑在主线程。 */
    public interface Listener {
        void onAudioFrame(Frame frame);
    }

    private final Listener listener;
    /**
     * 采集哪一路音频。
     *
     * 0 是全局混音（叠层用这个：它拿不到主应用 WebView 里那个 AnalyserNode）。
     * 播放内核（P2）传的是 ExoPlayer 自己的 `getAudioSessionId()` —— 只采这一首歌，
     * 比起全局混音不会被别的App 的声音混进来，量纲两边共用一套，画出来形状一致。
     */
    private final int audioSessionId;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public WallpaperAudioTap(Listener listener) {
        this(listener, 0);
    }

    public WallpaperAudioTap(Listener listener, int audioSessionId) {
        this.listener = listener;
        this.audioSessionId = audioSessionId;
    }

    private HandlerThread thread;
    private Handler worker;
    private Visualizer visualizer;

    private int captureSize = 0;
    /** 平滑后的幅度，长度 = captureSize / 2。只有采集线程碰它。 */
    private double[] smoothed;

    private volatile boolean running = false;
    /**
     * 起不来就不再试。
     *
     * 采集失败通常是恒定的（缺权限 / 机型不给 / 被别的进程占着），让它每轮巡检都重试
     * 只会白白烧电还会刷一堆异常。注意**不**因为「暂时没数据」而置位 ——
     * 蓝牙输出在切回扬声器之后是会恢复的。
     */
    private volatile boolean failed = false;

    /** 叠层挂上去之后调用。重复调用无害。 */
    public void start() {
        if (running || failed) {
            return;
        }
        running = true;
        // Visualizer 的回调跑在**创建它的线程**的 Looper 上。放在主线程上会让
        // FFT + 128 段重采样每 50ms 挤一次主线程，所以单独开一条。
        thread = new HandlerThread("folia-wallpaper-audio");
        thread.start();
        worker = new Handler(thread.getLooper());
        worker.post(this::attach);
    }

    /** 叠层收摊时调用。 */
    public void stop() {
        if (!running) {
            return;
        }
        running = false;
        if (worker != null) {
            // release 必须回到创建它的那条线程：Visualizer 不是线程安全的。
            worker.post(this::release);
            // quitSafely 会把队列里剩下的这条跑完再退，所以 release 一定执行得到。
            thread.quitSafely();
            thread = null;
            worker = null;
        }
    }

    private void attach() {
        if (!running) {
            return;
        }
        Visualizer probe = null;
        try {
            probe = new Visualizer(audioSessionId);
            int[] range = Visualizer.getCaptureSizeRange();
            // 捕获长度越大频率越细，但上限是 1024（Visualizer 的硬规定），
            // 也就是 512 个频点 —— 比页面侧的 1024 个粗一倍，分成 5 个 band 足够。
            int size = Math.min(1024, Math.max(128, range[1]));
            if (probe.setCaptureSize(size) != Visualizer.SUCCESS) {
                release(probe);
                failed = true;
                return;
            }
            int sampling = probe.getSamplingRate();
            if (sampling <= 0) {
                release(probe);
                failed = true;
                return;
            }
            int maxRate = probe.getMaxCaptureRate();
            // 单位是毫赫兹：20000 mHz = 20 次/秒。
            int rate = CAPTURE_FPS * 1000;
            if (maxRate > 0) {
                rate = Math.min(rate, maxRate);
            }
            if (probe.setDataCaptureListener(new Visualizer.OnDataCaptureListener() {
                @Override
                public void onWaveFormDataCapture(Visualizer visualizer, byte[] waveform, int samplingRate) {
                    // 只要频谱。
                }

                @Override
                public void onFftDataCapture(Visualizer visualizer, byte[] fft, int samplingRate) {
                    onFft(fft, samplingRate);
                }
            }, rate, false, true) != Visualizer.SUCCESS) {
                release(probe);
                failed = true;
                return;
            }
            /*
             * 缓冲必须在 setEnabled 之前备好。
             *
             * 回调是 post 到**同一个** Looper 上的，理论上不会插到这个方法中间执行，
             * 但顺序上把它写成「先备好再开门」就不用依赖那条推论 —— 采集回调里
             * 摸到 null 缓冲就是一整条崩溃。
             */
            captureSize = size;
            smoothed = new double[size / 2];
            if (probe.setEnabled(true) != Visualizer.SUCCESS) {
                release(probe);
                failed = true;
                return;
            }
            visualizer = probe;
        } catch (Throwable error) {
            Log.w(TAG, "音频采集起不来，叠层的音频响应维持原样", error);
            release(probe);
            failed = true;
        }
    }

    private void release() {
        Visualizer current = visualizer;
        visualizer = null;
        release(current);
    }

    private static void release(Visualizer target) {
        if (target == null) {
            return;
        }
        try {
            target.setEnabled(false);
        } catch (Throwable ignored) {
            // 已经没了。
        }
        try {
            target.release();
        } catch (Throwable ignored) {
            // 同上。
        }
    }

    /**
     * FFT 回调。
     *
     * 数据格式：`fft` 长度是 `captureSize * 2`，实部虚部交错，有效频点是前
     * `captureSize / 2` 个（0 .. Nyquist）。频率 = `k * samplingRate / captureSize`。
     * 下标 0 / 1 在 half-complex 打包下是 DC 与 Nyquist 的实部，这两点的误差
     * 在频谱上完全看不出来，所以按下标直接成对取，不做特殊处理。
     */
    private void onFft(byte[] fft, int samplingRateHz) {
        if (!running || fft == null || captureSize == 0) {
            return;
        }
        int bins = captureSize / 2;
        if (fft.length < bins * 2 || samplingRateHz <= 0) {
            return;
        }
        for (int index = 0; index < bins; index += 1) {
            double real = fft[index * 2];
            double imaginary = fft[index * 2 + 1];
            double magnitude = Math.sqrt(real * real + imaginary * imaginary);
            // 平滑放在幅度域，跟 Web Audio 一样（它对 dB 之前的值做指数平滑）。
            smoothed[index] = smoothed[index] * SMOOTHING + magnitude * (1.0 - SMOOTHING);
        }

        double hzPerBin = samplingRateHz / (double) captureSize;
        // 频率边界与 usePlaybackVisualizerBridge 的 computeBandEnergy 逐条对齐。
        double bassRaw = bandValue(hzPerBin, 20, 150);
        double lowMidRaw = bandValue(hzPerBin, 150, 400);
        double midRaw = bandValue(hzPerBin, 400, 1200);
        double vocalRaw = bandValue(hzPerBin, 1000, 3500);
        double trebleRaw = bandValue(hzPerBin, 3500, 12000);

        // shape 指数也与 usePlaybackVisualizerBridge 里的逐条对齐。
        final Frame frame = new Frame(
                shape((bassRaw + lowMidRaw) / 2.0, 3),
                shape(bassRaw, 1.8),
                shape(lowMidRaw, 2),
                shape(midRaw, 2),
                shape(vocalRaw, 1.5),
                shape(trebleRaw, 2));
        mainHandler.post(() -> listener.onAudioFrame(frame));
    }

    /** 一段频率里各 bin 的 0..255 值的平均，对齐 computeBandEnergy。 */
    private double bandValue(double hzPerBin, double minHz, double maxHz) {
        int start = (int) Math.floor(minHz / hzPerBin);
        int end = (int) Math.floor(maxHz / hzPerBin);
        if (start < 0) {
            start = 0;
        }
        if (end >= smoothed.length) {
            end = smoothed.length - 1;
        }
        if (end < start) {
            return 0;
        }
        double sum = 0;
        for (int index = start; index <= end; index += 1) {
            sum += toByte(smoothed[index]);
        }
        return sum / (end - start + 1);
    }

    /**
     * 线性幅度 → 0..255。
     *
     * 页面侧 `getByteFrequencyData` 给的是 dB 域（-100..-30 映射到 0..255），
     * Visualizer 给的是线性幅度，所以先转 dB 再减掉 DB_REFERENCE 那把尺子。
     */
    private static double toByte(double magnitude) {
        if (magnitude <= 1.0) {
            return 0;
        }
        double db = 20.0 * Math.log10(magnitude);
        double normalized = (db - DB_REFERENCE + 100.0) / DB_RANGE;
        if (normalized <= 0) {
            return 0;
        }
        if (normalized >= 1) {
            return 255;
        }
        return normalized * 255.0;
    }

    /** 对齐 shapeBandEnergy：pow(value / 255, boost) * 255。 */
    private static int shape(double value, double boost) {
        double normalized = value / 255.0;
        if (normalized <= 0) {
            return 0;
        }
        if (normalized > 1) {
            normalized = 1;
        }
        return (int) Math.round(Math.pow(normalized, boost) * 255.0);
    }
}
