package top.izuna.foliamajor.audio;

import android.content.Context;
import android.media.AudioFocusRequest;
import android.media.AudioManager;

/**
 * 交给 WebView 的那一个 AudioManager。
 *
 * 后台播放时别的应用一出声，系统就把音频焦点收走，Chromium 的 `AudioFocusDelegate`
 * 收到 AUDIOFOCUS_LOSS 会**直接把 `<audio>` 暂停** —— 它不等 Web 层表态，于是状态机
 * 还停在 PLAYING：界面显示「正在播」但没声音，而且之后经常叫不醒。
 *
 * 唯一的干预点就在它取 AudioManager 的那一步
 * （`ContextUtils.getApplicationContext().getSystemService(AUDIO_SERVICE)`）：
 * 这里把 Chromium 注册的焦点回调换成空实现 —— **它感知不到焦点丢失，就不会暂停**，
 * 两个音源真的同时响。焦点本身照旧申请：不申请的话系统会把它当背景噪音处理，
 * 有些 ROM 会直接压音量。
 *
 * 只有「与其他音源同时播放」开着时才会给出去（见 FoliaApplication.getSystemService）；
 * 关着时 WebView 拿到的是系统原装那个，行为与此前完全一致。
 */
public final class FoliaAudioManager extends AudioManager {

    private final Context context;

    public FoliaAudioManager(Context context) {
        super(context);
        this.context = context;
    }

    /**
     * API 26+ 走这个重载（Chromium 自己也是按 Build.VERSION 分两支的）。
     *
     * 用 `AudioFocusRequest.Builder(AudioFocusRequest)` 复制原请求、只换掉监听：
     * 焦点类型、音轨属性、duck 行为全都保留下来。少复制任何一项都可能让系统在
     * 别的场景（来电、导航播报）对待我们的方式跟着变。
     */
    @Override
    public int requestAudioFocus(AudioFocusRequest focusRequest) {
        if (focusRequest == null || !FoliaAudioFocus.mixWithOthers(context)) {
            return super.requestAudioFocus(focusRequest);
        }
        AudioFocusRequest detached = new AudioFocusRequest.Builder(focusRequest)
                .setOnAudioFocusChangeListener(change -> { })
                .build();
        return super.requestAudioFocus(detached);
    }

    /** API 24 / 25 走这个旧重载（minSdk 是 24）。 */
    @Override
    public int requestAudioFocus(OnAudioFocusChangeListener listener, int streamType, int durationHint) {
        if (!FoliaAudioFocus.mixWithOthers(context)) {
            return super.requestAudioFocus(listener, streamType, durationHint);
        }
        return super.requestAudioFocus(change -> { }, streamType, durationHint);
    }
}
