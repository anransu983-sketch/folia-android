package com.suanran.folia;

import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 让用户登录 YouTube 的那一屏（一座独立 Activity 里的 WebView）。
 *
 * 为什么必须有它：YouTube 没有给 YouTube Music 的 OAuth，登录凭据只能是 cookie；而
 * cookie 只能从「用户真的登录过的那个 WebView」里读 —— Chrome Custom Tab 的 cookie 落在
 * Chrome 自己的罐里，我们读不到；把主界面那个 WebView 直接导航到 accounts.google.com
 * 等于把整个应用页面换掉。所以单独开一座 Activity 装一个 WebView，登录完把 cookie 交回去。
 *
 * ⚠️ 已知风险：**Google 会拒绝「被嵌入的浏览器」登录**（提示“此浏览器或应用可能不安全”）。
 * 它按 UA 里的 `; wv)`（WebView 标记）认，所以这里把 UA 里那个标记去掉 —— 这一步能过就过，
 * 过不了用户在页面上会直接看到 Google 自己的提示，不会假装成功。真被拒时的退路是
 * 「用 Chrome 登录 + 手动导出 cookie」，那不是本轮要做的。
 *
 * 取数层不在这里：cookie 交回去之后，youtubei.js 在主 WebView 里用它请求（见
 * services/onlineMusic/ytm/ytmInPageRuntime）。
 */
public class YtmSignInActivity extends AppCompatActivity {
    private static final String TAG = "FoliaYtmSignIn";

    /** 起点用 YouTube Music 自己，而不是直接进 accounts.google.com：
     *  由页面自己发起登录，来源与跳转都是 Google 认得的那一条，比凭空拼一个登录 URL 稳。 */
    private static final String START_URL = "https://music.youtube.com/";
    /** 读 cookie 用的两个域：登录态在 youtube.com 上，music.youtube.com 也可能各有一份。 */
    private static final String[] COOKIE_URLS = { "https://www.youtube.com/", "https://music.youtube.com/" };
    /** 桌面端判定「登录了」看的就是这一个 cookie（见 electron/ytm/browserSignIn.cjs）。 */
    private static final String SIGNED_IN_COOKIE = "SAPISID";

    /** 结果回调。静态是因为插件要从它的那一边起这座 Activity；用完立刻清掉。 */
    public interface Listener {
        void onDone(String cookie, String userAgent);

        void onCancelled();
    }

    private static volatile Listener listener;

    public static void start(android.content.Context context, Listener callback) {
        listener = callback;
        Intent intent = new Intent(context, YtmSignInActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    private WebView webView;
    private String userAgent = "";
    private boolean handedOver = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 主题在清单里给（@style/AppTheme.NoActionBar），与 CrashActivity 一致。

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);
        root.setFitsSystemWindows(false);

        root.addView(buildBar());

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        /*
         * 去掉 UA 里的 `; wv)`（WebView 标记）。
         *
         * Google 拿它判定「这是被嵌在某个 App 里的浏览器」并拒绝登录。去掉之后 UA 与这台
         * 设备上 Chrome 的一致，剩下的信息（系统版本、机型）都是真的 —— 这不是伪装成别的
         * 设备，只是不让 WebView 的标识把自己挡在门外。
         */
        String original = settings.getUserAgentString();
        userAgent = original == null ? "" : original.replace("; wv)", "");
        settings.setUserAgentString(userAgent);
        // 登录要跨 accounts.google.com 与 youtube.com 写 cookie，第三方 cookie 必须开。
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // 登录一完成就直接带着 cookie 回去，不必再让用户点「完成」。
                if (isSignedIn()) {
                    finishWithCookies();
                }
            }
        });
        webView.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(webView);

        setContentView(root);
        webView.loadUrl(START_URL);
    }

    /** 顶上一条：左边取消、右边「完成」（自动判定没赶上时用它手动收）。 */
    private View buildBar() {
        LinearLayout bar = new LinearLayout(this);
        int height = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 52, getResources().getDisplayMetrics());
        bar.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height));
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#111111"));

        bar.addView(barButton("取消", view -> {
            handOver(null);
        }));
        TextView title = new TextView(this);
        title.setText("登录 YouTube Music");
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        title.setGravity(Gravity.CENTER);
        title.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(title);
        bar.addView(barButton("完成", view -> {
            // 没检测到登录态也照用户说的收：cookie 判定有可能漏，而用户看得见自己登没登。
            finishWithCookies();
        }));
        return bar;
    }

    private Button barButton(String text, View.OnClickListener onClick) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setOnClickListener(onClick);
        return button;
    }

    private boolean isSignedIn() {
        String cookie = readCookies();
        return cookie != null && cookie.contains(SIGNED_IN_COOKIE + "=");
    }

    private void finishWithCookies() {
        CookieManager.getInstance().flush();
        handOver(readCookies());
    }

    /**
     * 拼出一条 Cookie 头。
     *
     * 同名 cookie 只留一个（www.youtube.com 与 music.youtube.com 上可能都有）：
     * 库那边是「取它找到的第一个」，留两个就等于把顺序交给运气 —— 而带错的那一个
     * 表现为「看着登录了，取自己的歌单却说未登录」。
     */
    private String readCookies() {
        CookieManager manager = CookieManager.getInstance();
        Map<String, String> chosen = new LinkedHashMap<>();
        for (String url : COOKIE_URLS) {
            String cookies = manager.getCookie(url);
            if (cookies == null || cookies.isEmpty()) continue;
            for (String pair : cookies.split("; ")) {
                int split = pair.indexOf('=');
                if (split <= 0) continue;
                String name = pair.substring(0, split).trim();
                String value = pair.substring(split + 1).trim();
                if (name.isEmpty() || value.isEmpty()) continue;
                // 账户自己的那个域优先：后来的不覆盖已有的，第一个来源（www.youtube.com）为准。
                if (!chosen.containsKey(name)) chosen.put(name, value);
            }
        }
        if (chosen.isEmpty()) return null;
        StringBuilder header = new StringBuilder();
        for (Map.Entry<String, String> entry : chosen.entrySet()) {
            if (header.length() > 0) header.append("; ");
            header.append(entry.getKey()).append('=').append(entry.getValue());
        }
        return header.toString();
    }

    /** 把结果交回去（并且只交一次：页面回调与「完成」按钮可能都走到这里）。 */
    private void handOver(String cookie) {
        if (handedOver) return;
        handedOver = true;
        Listener callback = listener;
        listener = null;
        if (callback == null) {
            finish();
            return;
        }
        if (cookie == null || cookie.isEmpty()) {
            Log.w(TAG, "no YouTube cookie was found; the sign-in did not happen");
            callback.onCancelled();
        } else {
            callback.onDone(cookie, userAgent);
        }
        finish();
    }

    @Override
    public void onBackPressed() {
        // 返回键当作取消：不能让用户在登录中途被卡在这一屏。
        super.onBackPressed();
        handOver(null);
    }

    @Override
    protected void onDestroy() {
        // 用户用别的方式（手势返回、被系统回收）离开了：收掉，别让插件那边一直等。
        if (!handedOver) handOver(null);
        if (webView != null) {
            webView.setWebViewClient(new WebViewClient());
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
