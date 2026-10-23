package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Web 层与 FoliaPlaybackService 之间的桥。
 *
 * Web 层不直接 startForegroundService（那需要暴露原生 API 给任意 JS 调用），
 * 而是通过这个插件把意图转成 service 的 startService 动作。
 *
 * 注意 Android 8+ 不允许后台启动服务，所以 startForegroundService 之后
 * 服务端必须在一个「准点」上调用 startForeground 来满足系统的 5 秒要求。
 * 「要前台化」时用 startForegroundService，服务已经在前台时改走普通 startService
 * （见 startServiceCompat）。
 */
@CapacitorPlugin(name = "FoliaPlayback")
public class FoliaPlaybackPlugin extends Plugin {

    private static final String TAG = "FoliaPlaybackPlugin";

    /**
     * 服务发来的控制命令经 MainActivity 的广播接收器转到这里，再派发给 JS。
     * 事件名必须与 Web 层 FoliaPlayback.addListener 订阅的保持一致。
     */
    private static final String EVENT_COMMAND = "foliaPlaybackCommand";

    /**
     * 通知栏/耳机按键在后台触发时，Activity 可能已经不在了，
     * 只能从静态引用拿到插件实例（见 FoliaCommandReceiver）。
     */
    private static volatile FoliaPlaybackPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        instance = null;
        super.handleOnDestroy();
    }

    static void dispatchCommandFromReceiver(String command, long positionMs) {
        FoliaPlaybackPlugin current = instance;
        if (current != null) {
            current.dispatchCommand(command, positionMs);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable; cannot update playback metadata.");
            return;
        }

        Intent intent = new Intent(activity, FoliaPlaybackService.class);
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_METADATA);
        String title = call.getString("title");
        String artist = call.getString("artist");
        String album = call.getString("album");
        String artwork = call.getString("artworkBase64");
        Integer duration = call.getInt("durationMs");

        if (title != null) intent.putExtra(FoliaPlaybackService.EXTRA_TITLE, title);
        if (artist != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTIST, artist);
        if (album != null) intent.putExtra(FoliaPlaybackService.EXTRA_ALBAND, album);
        if (artwork != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTWORK, artwork);
        // 同时把封面地址给过去：原生自己下载，绕开 WebView 的 CORS 限制。
        String artworkUrl = call.getString("artworkUrl");
        if (artworkUrl != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTWORK_URL, artworkUrl);
        if (duration != null) intent.putExtra(FoliaPlaybackService.EXTRA_DURATION, (long) duration);
        // 封面角标用哪颗图标：当前播放来源的平台（netease/qq/kugou/bodian/folia）。
        String providerBadge = call.getString("providerBadge");
        if (providerBadge != null) intent.putExtra(FoliaPlaybackService.EXTRA_PROVIDER_BADGE, providerBadge);
        // 当前这首歌的身份：服务端拿它判断是不是换歌了，换歌时要先丢掉上一首的封面。
        String songKey = call.getString("songKey");
        if (songKey != null) intent.putExtra(FoliaPlaybackService.EXTRA_SONG_KEY, songKey);
        // 「喜欢」状态：通知栏那颗心画实心还是空心，以及这颗心该不该出现。
        // 用 hasExtra 语义（JS 侧显式传 boolean 才有这个 extra），不传就是「这次不改」。
        Boolean liked = call.getBoolean("liked");
        if (liked != null) intent.putExtra(FoliaPlaybackService.EXTRA_LIKED, liked.booleanValue());
        Boolean canLike = call.getBoolean("canLike");
        if (canLike != null) intent.putExtra(FoliaPlaybackService.EXTRA_CAN_LIKE, canLike.booleanValue());

        startServiceCompat(activity, intent);
        call.resolve();
    }

    @PluginMethod
    public void setState(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable; cannot update playback state.");
            return;
        }

        String state = call.getString("state");

        // 只有真正在播放时才值得起前台服务。
        //
        // Web 层在挂载时就会推一次 state='stopped'（currentSong 为空时的初始态），
        // 于是「一打开应用」就会 startForegroundService 把服务拉起来 ——
        // 那段路径此前从未真正执行过（插件没注册成功），一跑就崩。
        // 服务没在跑而状态又是 stopped/paused 时，直接忽略，不做任何原生调用。
        boolean needsService = "playing".equals(state);
        if (!needsService && !FoliaPlaybackService.isRunning()) {
            call.resolve();
            return;
        }

        Intent intent = new Intent(activity, FoliaPlaybackService.class);
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_STATE);
        if (state != null) intent.putExtra(FoliaPlaybackService.EXTRA_STATE, state);
        Integer position = call.getInt("positionMs");
        if (position != null) intent.putExtra(FoliaPlaybackService.EXTRA_POSITION, (long) position);
        Float speed = call.getFloat("speed");
        if (speed != null) intent.putExtra(FoliaPlaybackService.EXTRA_SPEED, speed);

        startServiceCompat(activity, intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Activity activity = getActivity();
        // 服务没在跑就没什么可停的。注意这里原先会无条件 startService，
        // 于是「打开应用、还没有歌」也会把一个前台服务拉起来再停掉。
        if (activity == null || !FoliaPlaybackService.isRunning()) {
            call.resolve();
            return;
        }
        Intent intent = new Intent(activity, FoliaPlaybackService.class);
        intent.setAction(FoliaPlaybackService.ACTION_STOP_FOREGROUND);
        activity.startService(intent);
        call.resolve();
    }

    /**
     * 把服务端的播放/切歌意图派发给 Web 层。
     *
     * 用 Capacitor 的事件通道而不是直接调用 Web 层方法：JS 侧通过
     * FoliaPlayback.onCommand(handler) 订阅，插件内部只管 notifyListeners。
     */
    public void dispatchCommand(String command) {
        dispatchCommand(command, 0L);
    }

    public void dispatchCommand(String command, long positionMs) {
        JSObject payload = new JSObject();
        payload.put("command", command);
        payload.put("positionMs", positionMs);
        notifyListeners(EVENT_COMMAND, payload);
    }

    /**
     * 把服务端的播放/切歌意图转成一个供 Web 层订阅的 CustomEvent。
     *
     * 服务与 Activity 是不同组件；这里统一由插件在 Activity 存活期间接收广播，
     * 再 notifyListeners 派发给 JS。Web 层据此调用自己的播放控制，
     * 避免在原生侧再实现一套播放器状态机。
     */
    public static void dispatchCommandToWeb(Context context, String command) {
        // Android 8+ 不再给隐式广播投递给清单注册的接收器，必须写死组件名。
        Intent intent = new Intent(context, FoliaCommandReceiver.class);
        intent.setAction(FoliaPlaybackService.ACTION_WEB_COMMAND);
        intent.putExtra(FoliaPlaybackService.EXTRA_COMMAND, command);
        context.sendBroadcast(intent);
    }

    /**
     * 只在「这条 intent 需要把服务顶到前台」时才用 startForegroundService。
     *
     * startForegroundService 给**每一次**启动都开一个「5 秒内必须 startForeground()」
     * 的倒计时，而播放位置是每秒推一次的 —— 服务已经在前台时仍走这条路，服务端就
     * 得每秒调一次 startForeground() 去兑现。通知里带着 512×512 的封面 Bitmap
     * （约 1 MB），那是每秒在主线程上搬一次 1 MB：播放页单帧本来就要二三十毫秒，
     * 被它定期拖一下就是肉眼可见的卡顿。
     *
     * 而服务已经在前台时，这条 intent 只是「更新一下内容」，不需要新的前台化承诺 ——
     * 普通 startService 不开倒计时，也就不用兑。（进程里有前台服务，系统当它是前台，
     * 后台启动服务的限制在这里不适用。）
     */
    private void startServiceCompat(Activity activity, Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !FoliaPlaybackService.isForegrounded()) {
            try {
                activity.startForegroundService(intent);
                return;
            } catch (Throwable error) {
                // 起不来就退回普通那条路：服务要是在跑，内容照样能送到。
                Log.e(TAG, "startForegroundService failed; falling back to startService", error);
            }
        }
        try {
            activity.startService(intent);
        } catch (Throwable error) {
            Log.e(TAG, "startService failed", error);
        }
    }
}
