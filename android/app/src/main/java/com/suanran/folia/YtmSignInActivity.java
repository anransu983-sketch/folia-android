package com.suanran.folia;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
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
    /** 自动交接漏检兜底的轮询间隔（毫秒），取值理由见 signInPoll 的注释。 */
    private static final long SIGN_IN_POLL_MS = 2000L;

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
    private TextView statusLabel;
    /** 当前这一页是否已报过主框架错误：报过就别让随后的 onPageFinished 把错误文字藏掉。 */
    private boolean pageErrorShown = false;
    private String userAgent = "";
    private boolean handedOver = false;

    private final Handler signInPollHandler = new Handler(Looper.getMainLooper());
    /**
     * 每 SIGN_IN_POLL_MS 查一次登录态，命中就自动交接。
     *
     * 为什么需要它：原先自动交接只挂在 onPageFinished 上，可登录走完回到
     * music.youtube.com 是单页应用内的跳转，未必再有整页加载事件；就算有，那一次
     * onPageFinished 也可能赶在 SAPISID 落进 CookieManager 之前。两种情况都会让自动
     * 交接永不触发，用户只能手动离开，而手动离开在旧语义下等于取消（见 onBackPressed
     * 的注释，真机实证被判「未完成」）。轮询把这条缝补上：间隔取 2 秒，是因为读
     * cookie 只是一次字符串拼装、开销可忽略，而用户登完后多等的上限就是一个间隔；
     * 起点同样延后一个间隔，让整页加载那条快路（onPageFinished）先行，轮询只做兜底。
     * 交接或销毁时停表（见 handOver / onDestroy），不留尾巴。
     */
    private final Runnable signInPoll = new Runnable() {
        @Override
        public void run() {
            if (handedOver) return;
            if (isSignedIn()) {
                finishWithCookies();
                return;
            }
            signInPollHandler.postDelayed(this, SIGN_IN_POLL_MS);
        }
    };

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
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                // 每开一页先给一行加载提示：页面没出来时用户至少知道还在加载，不是卡死。
                pageErrorShown = false;
                showStatus("正在加载…");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!pageErrorShown) hideStatus();
                // 登录一完成就直接带着 cookie 回去，不必再让用户点「完成」。
                if (isSignedIn()) {
                    finishWithCookies();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 只管主框架：子资源（图片/脚本）失败不该把整页判死。
                if (request == null || !request.isForMainFrame()) return;
                pageErrorShown = true;
                showStatus("页面加载失败（错误 " + error.getErrorCode() + "：" + error.getDescription() + "）\n"
                    + "请检查网络或代理后，点上方「完成」重试，或点「取消」退出。");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request == null || !request.isForMainFrame()) return;
                int code = response.getStatusCode();
                if (code < 400) return;
                pageErrorShown = true;
                showStatus("页面加载失败（HTTP " + code + " " + response.getReasonPhrase() + "）\n"
                    + "请检查网络或代理后，点上方「完成」重试，或点「取消」退出。");
            }
        });
        // WebView 与状态字同住一格：加载/出错时状态字压在页面中央，白屏也要有字可看
        // （真机实证：页面加载不出来时整片空白、无任何提示，用户无从判断发生了什么）。
        FrameLayout pageArea = new FrameLayout(this);
        pageArea.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        webView.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        pageArea.addView(webView);
        statusLabel = buildStatusLabel();
        pageArea.addView(statusLabel);
        root.addView(pageArea);

        setContentView(root);
        webView.loadUrl(START_URL);
        // 自动交接漏检兜底：整页事件没赶上时靠它把登录态收回来（见 signInPoll 的注释）。
        signInPollHandler.postDelayed(signInPoll, SIGN_IN_POLL_MS);
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

    /** 压在页面中央的一块状态字：加载中报进度、主框架出错报错误，都只用它，不另造界面。 */
    private TextView buildStatusLabel() {
        TextView label = new TextView(this);
        label.setTextColor(Color.WHITE);
        label.setTextSize(14);
        label.setGravity(Gravity.CENTER);
        int pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 16, getResources().getDisplayMetrics());
        label.setPadding(pad, pad, pad, pad);
        label.setBackgroundColor(Color.parseColor("#222222"));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.gravity = Gravity.CENTER;
        label.setLayoutParams(params);
        label.setVisibility(View.GONE);
        return label;
    }

    private void showStatus(String text) {
        statusLabel.setText(text);
        statusLabel.setVisibility(View.VISIBLE);
    }

    private void hideStatus() {
        statusLabel.setVisibility(View.GONE);
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
        // 交接是唯一的出口：到这里就停轮询，别让它在 finish 之后还空转。
        signInPollHandler.removeCallbacks(signInPoll);
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
        /*
         * 返回键 = 「我登完了，验收」，不是取消。
         *
         * Web 侧的等待文案教用户「看到 YouTube Music 显示你的账号后，关掉那个窗口」，
         * 而在这座 Activity 里关窗口最自然的动作就是返回键/手势 —— 旧写法把它当取消
         * 且不带 cookie，于是用户照文案把整个登录走完，照样被判「未完成」（真机实证）。
         * 所以返回走与「完成」按钮同一条路：先收 cookie 再交接；真没登成的人读不到
         * cookie，handOver 仍会判取消，不会被冒认。明确的取消只留给顶栏「取消」按钮，
         * 两个动作从此分工不含糊。
         *
         * 不调 super：出口由 handOver 统一收口（它内部会 finish()），系统默认的返回
         * 销毁再掺一脚只会和它抢顺序。登录中途按返回仍会离开这一屏，只是离开前先
         * 验收一次，不会把人卡住。
         */
        finishWithCookies();
    }

    @Override
    protected void onDestroy() {
        // 走到这里还没交接，说明是被系统回收这类非验收路径离开的：收掉，别让插件那边
        // 一直等。（返回键/手势不走这里，它们在 onBackPressed 里先按验收处理。）
        if (!handedOver) handOver(null);
        // 轮询停表在 handOver 里已做一遍，这里再兜一遍，防任何绕开 handOver 的销毁路径。
        signInPollHandler.removeCallbacks(signInPoll);
        if (webView != null) {
            webView.setWebViewClient(new WebViewClient());
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
