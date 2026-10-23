package com.suanran.folia;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * YouTube Music 登录的原生桥（FoliaYtm）。
 *
 * 与汽水那条路**刻意不同**：这里原生只负责「让人登录一次，把 YouTube 的 cookie 交出来」，
 * 协议层（youtubei.js）跑在主 WebView 里 —— 它本来就是浏览器库，不该塞进一个隐藏 WebView。
 * 原生侧因此只有一座 Activity，没有任何取数代码。
 *
 * 为什么非得走原生：YouTube 没给 YouTube Music 的 OAuth，凭据只能是 cookie；而 cookie
 * 只能从「用户真的登录过的那个 WebView」里读。主界面那个 WebView 直接导航到
 * accounts.google.com 等于把整个应用换掉，Chrome Custom Tab 的 cookie 又落进 Chrome 自己的
 * 罐里 —— 所以单独开 {@link YtmSignInActivity} 装一个 WebView，登录完把 cookie 交回来。
 *
 * 没登录也**不意味着不可用**：搜索 / 专辑 / 歌单 / 歌词都是公开接口，匿名就能通。这座
 * Activity 只在「要用户自己的歌单」时才用得上 —— 这也是为什么平台上「能不能用」与
 * 「能不能登录」在 Web 侧是两件事（见 ytmInPageRuntime 的说明）。
 */
@CapacitorPlugin(name = "FoliaYtm")
public class FoliaYtmPlugin extends Plugin {
    private static final String TAG = "FoliaYtm";
    /** 与桌面端一致：一次登录最多等十分钟，超时就明说，别让界面一直转。 */
    private static final long ATTEMPT_MS = 10 * 60 * 1000L;
    /** 是否已有一回登录在途。交结果靠 Activity 的静态 listener（只能挂一份），所以必须拦并发，见 signIn。 */
    private final AtomicBoolean signInInFlight = new AtomicBoolean(false);

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ready", true);
        call.resolve(result);
    }

    /**
     * 起登录那一屏，并把 cookie 带回来。
     *
     * 答 `{ ok: true, session: { cookie, userAgent } }`；取消 / 没登 / 超时是
     * `{ ok: false, error: { code, message } }` —— **不是** reject：reject 到 JS 侧会被统一
     * 折成 `unavailable`，「用户取消了」和「这台设备上根本没有这条路」就分不开了。
     */
    @PluginMethod
    public void signIn(PluginCall call) {
        android.content.Context context = getContext();
        if (context == null) {
            call.resolve(failure("unavailable", "The YouTube Music sign-in has no context to start from"));
            return;
        }
        /*
         * 防并发劫持：Activity 交结果靠一个静态 listener，后起的 start 会把它覆盖掉 ——
         * 先开的那座交接时喊到的已是后来者的回调，它自己那份调用只能等十分钟超时，
         * 表现为「登录窗一闪而过 / 开了又自己关、结果是 cancelled」。所以在途时第二
         * 次调用直接明说 busy，根本不许它碰 listener。
         */
        if (!signInInFlight.compareAndSet(false, true)) {
            call.resolve(failure("busy", "A YouTube Music sign-in is already in progress"));
            return;
        }
        call.setKeepAlive(true);
        final AtomicBoolean settled = new AtomicBoolean(false);
        final Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> {
            if (settled.compareAndSet(false, true)) {
                signInInFlight.set(false);
                Log.w(TAG, "the sign-in did not finish in time");
                call.resolve(failure("sign-in-failed", "The YouTube Music sign-in was not finished in time"));
            }
        }, ATTEMPT_MS);

        try {
            YtmSignInActivity.start(context, new YtmSignInActivity.Listener() {
            @Override
            public void onDone(String cookie, String userAgent) {
                if (!settled.compareAndSet(false, true)) return;
                signInInFlight.set(false);
                handler.removeCallbacksAndMessages(null);
                JSObject session = new JSObject();
                session.put("cookie", cookie);
                // 取 cookie 那个 WebView 的 UA 必须一起回去：YouTube 会按 UA 决定给不给某些
                // 接口，UA 与 cookie 不同源就表现为「登录了但取不到自己的东西」。
                session.put("userAgent", userAgent);
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("session", session);
                call.resolve(result);
            }

            @Override
            public void onCancelled() {
                if (!settled.compareAndSet(false, true)) return;
                signInInFlight.set(false);
                handler.removeCallbacksAndMessages(null);
                call.resolve(failure("cancelled", "The YouTube Music sign-in was cancelled"));
            }
            });
        } catch (RuntimeException e) {
            // 起窗这一步就抛了：把在途标记和超时回调一并收掉，别让 busy 锁死后续所有登录。
            if (settled.compareAndSet(false, true)) {
                signInInFlight.set(false);
                handler.removeCallbacksAndMessages(null);
                Log.w(TAG, "the sign-in screen could not be started", e);
                call.resolve(failure("sign-in-failed", "The YouTube Music sign-in screen could not be started"));
            }
        }
    }

    private static JSObject failure(String code, String message) {
        JSObject error = new JSObject();
        error.put("code", code);
        error.put("message", message);
        JSObject result = new JSObject();
        result.put("ok", false);
        result.put("error", error);
        return result;
    }
}
