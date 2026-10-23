package top.izuna.foliamajor;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 启动时的 WebView 体检与升级引导。
 *
 * 为什么要有它：Folia 的整个界面就是 WebView 里跑的一个现代前端产物（ES2020+ 语法、
 * WebGL2、Intl.Segmenter 分词、ResizeObserver 等）。这些在「系统 WebView」里才有，
 * 而系统 WebView 是独立升级的组件 —— 一台 Android 版本不低的机器，也可能装着 2019 年的
 * WebView，于是表现是开屏后白屏、JS 直接抛 SyntaxError/TypeError，而 App 侧拿不到
 * 任何线索（崩溃处理器抓不到，因为那是 WebView 内部的脚本错误）。
 *
 * 所以它必须做在**原生侧**、在页面加载之后立刻做：只有原生这里能拿到引擎版本，
 * 也只有原生对话框能在页面已经废掉的情况下仍然弹出来。
 *
 * 关于「升级」：Android 不允许应用替用户更新系统组件，没有静默升级这一说。
 * 能做的是把用户送到能更新的地方，按顺序试：
 *   1. `market://details?id=<webview 包>` —— 有 Play 商店的设备直接落到 WebView 详情页；
 *      国内部分厂商商店也注册了 market 协议，同样能接住。
 *   2. `android.settings.WEBVIEW_SETTINGS`（Android 10+）—— 系统自带的 WebView 实现页，
 *      没有商店的设备至少能看到当前用的是哪个实现。
 *   3. Play 网页版 —— 兜底，浏览器打得开就行。
 * 三个都接不住就 Toast 一句，让用户自己找途径。
 */
public final class WebViewUpgrade {

    /**
     * Folia 能正常跑的最低 Chromium 主版本。
     *
     * 定 100 的依据（都是真在用、缺了就整页废掉的）：
     *   - `Intl.Segmenter`：歌词按字素切分，20 多处引用，Chrome 87 才有；
     *   - 顶层 await / `??=`：构建产物的语法基线；
     *   - `AbortSignal.timeout`、CSS `:has()`：Chrome 103 / 105。
     * 低于这个数的 WebView 不是「功能少一点」，而是开屏直接报错，所以按不支持处理。
     * 要放宽或收紧只改这一个常量。
     */
    public static final int MIN_CHROMIUM_MAJOR = 100;

    /** 兜底包名：`getCurrentWebViewPackage()` 拿不到时，商店页面至少要指到它。 */
    private static final String DEFAULT_WEBVIEW_PACKAGE = "com.google.android.webview";

    /** API 26 以下没有官方查询入口，只能按这几个已知包名挨个试。 */
    private static final String[] LEGACY_WEBVIEW_PACKAGES = {
            "com.google.android.webview",
            "com.android.webview",
            "com.android.chrome",
    };

    private static final Pattern CHROME_UA = Pattern.compile("Chrome/(\\d+)");

    private static final String TAG = "FoliaWebViewUpgrade";

    private static volatile boolean prompted = false;

    private WebViewUpgrade() {}

    /** 检测结果。版本拿不到时 major 为 -1，这种情况一律按「支持」处理，避免误报。 */
    public static final class Info {

        public final String packageName;
        public final String versionName;
        /** Chromium 主版本号（如 131），拿不到为 -1。 */
        public final int major;
        /** 版本是从哪来的：package / user-agent / unknown，日志里好定位。 */
        public final String source;

        Info(String packageName, String versionName, int major, String source) {
            this.packageName = packageName;
            this.versionName = versionName;
            this.major = major;
            this.source = source;
        }

        public boolean isKnown() {
            return major > 0;
        }

        /** 未知版本算支持：宁可漏报，也不要把好好的设备拦在门外。 */
        public boolean isSupported() {
            return !isKnown() || major >= MIN_CHROMIUM_MAJOR;
        }

        /** 给日志/崩溃报告用的一行描述。 */
        public String describe() {
            if (!isKnown()) {
                return "unknown (" + source + ")";
            }
            return String.format(Locale.US, "%d [%s] %s (%s)",
                    major, isSupported() ? "ok" : "too-old",
                    versionName == null ? "?" : versionName,
                    packageName == null ? source : packageName);
        }
    }

    /**
     * 读当前 WebView 的版本。
     *
     * `webView` 可以为空（比如崩溃处理器在 Application 里调用，那时还没建 Bridge），
     * 为空就少了 UA 这一路兜底，只走包名查询。
     *
     * 两路结果取**较大的那个**：个别 ROM 的 WebView 包名 versionName 不是 Chromium 版本号
     * （见过 "10.0.3" 这种），直接拿它当主版本会误判成不支持；而 UA 里那个 Chrome/x
     * 才是真正跑着的引擎，两者不一致时信高的那个。
     */
    public static Info inspect(Context context, WebView webView) {
        Info fromPackage = inspectPackage(context);
        Info fromUserAgent = inspectUserAgent(webView);
        if (fromPackage.isKnown() && fromUserAgent.isKnown()) {
            return fromPackage.major >= fromUserAgent.major ? fromPackage : fromUserAgent;
        }
        if (fromPackage.isKnown()) {
            return fromPackage;
        }
        if (fromUserAgent.isKnown()) {
            return fromUserAgent;
        }
        return new Info(null, null, -1, "unknown");
    }

    private static Info inspectPackage(Context context) {
        if (context == null) {
            return new Info(null, null, -1, "unknown");
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // API 26+ 的官方入口，返回的就是系统当前选定的那个 WebView 实现。
            PackageInfo info = WebView.getCurrentWebViewPackage();
            int major = info == null ? -1 : parseMajor(info.versionName);
            if (major > 0) {
                return new Info(info.packageName, info.versionName, major, "package");
            }
            return new Info(null, null, -1, "unknown");
        }
        // 低版本只能自己查。这里的 getPackageInfo 只会在 API < 26 上跑到，
        // 所以既不受 Android 11 的包可见性限制，也不会被 API 33 的弃用提示波及。
        PackageManager manager = context.getPackageManager();
        if (manager == null) {
            return new Info(null, null, -1, "unknown");
        }
        for (String pkg : LEGACY_WEBVIEW_PACKAGES) {
            PackageInfo info;
            try {
                info = manager.getPackageInfo(pkg, 0);
            } catch (PackageManager.NameNotFoundException absent) {
                continue;
            }
            int major = parseMajor(info == null ? null : info.versionName);
            if (major > 0) {
                return new Info(pkg, info.versionName, major, "package");
            }
        }
        return new Info(null, null, -1, "unknown");
    }

    private static Info inspectUserAgent(WebView webView) {
        if (webView == null) {
            return new Info(null, null, -1, "unknown");
        }
        String userAgent;
        try {
            userAgent = webView.getSettings().getUserAgentString();
        } catch (Throwable unusable) {
            return new Info(null, null, -1, "unknown");
        }
        int major = majorFromUserAgent(userAgent);
        return major > 0 ? new Info(null, userAgent, major, "user-agent")
                : new Info(null, null, -1, "unknown");
    }

    /** "131.0.6778.39" → 131。取第一段数字，后面的点分位与后缀都不影响判断。 */
    private static int parseMajor(String versionName) {
        if (versionName == null) {
            return -1;
        }
        String text = versionName.trim();
        int end = 0;
        while (end < text.length() && Character.isDigit(text.charAt(end))) {
            end += 1;
        }
        if (end == 0) {
            return -1;
        }
        try {
            return Integer.parseInt(text.substring(0, end));
        } catch (NumberFormatException tooLong) {
            return -1;
        }
    }

    private static int majorFromUserAgent(String userAgent) {
        if (userAgent == null) {
            return -1;
        }
        Matcher matcher = CHROME_UA.matcher(userAgent);
        if (!matcher.find()) {
            return -1;
        }
        try {
            return Integer.parseInt(matcher.group(1));
        } catch (NumberFormatException tooLong) {
            return -1;
        }
    }

    /**
     * 启动检查：不支持就弹框并告诉用户去升级。
     *
     * 只在**同一进程内**弹一次 —— 从商店切回来会走 onResume，反复弹就成了骚扰。
     * 返回 true 表示「已判定为不支持并弹了框」，调用方据此决定要不要继续后面的初始化。
     */
    public static boolean check(Activity activity, WebView webView) {
        if (activity == null || prompted) {
            return false;
        }
        Info info = inspect(activity, webView);
        if (info.isSupported()) {
            if (info.isKnown()) {
                Log.i(TAG, "WebView ok: " + info.describe());
            } else {
                Log.w(TAG, "WebView version unknown, skipping the gate: " + info.describe());
            }
            return false;
        }
        prompted = true;
        Log.w(TAG, "WebView too old: " + info.describe());
        showPrompt(activity, info);
        return true;
    }

    /** 供外部（以及将来的设置页入口）直接拉起升级流程。 */
    public static void prompt(Activity activity) {
        if (activity == null) {
            return;
        }
        showPrompt(activity, inspect(activity, null));
    }

    private static void showPrompt(Activity activity, Info info) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            return;
        }
        String current = info.isKnown() ? String.valueOf(info.major) : "?";
        String message = activity.getString(R.string.webview_upgrade_message,
                MIN_CHROMIUM_MAJOR, current);
        try {
            new AlertDialog.Builder(activity, R.style.WebViewUpgradeDialog)
                    .setTitle(R.string.webview_upgrade_title)
                    .setMessage(message)
                    .setCancelable(true)
                    .setPositiveButton(R.string.webview_upgrade_action_update,
                            (dialog, which) -> openUpgrade(activity, info))
                    // 点框外或返回键等于「仍要继续」，不额外拦一道。
                    .setNeutralButton(R.string.webview_upgrade_action_continue, null)
                    .setNegativeButton(R.string.webview_upgrade_action_exit,
                            (dialog, which) -> {
                                if (!activity.isFinishing()) {
                                    activity.finish();
                                }
                            })
                    .show();
        } catch (Throwable windowGone) {
            // Activity 已经在收尾（转屏、被回收）时 show 会抛，记一句就够，别二次崩溃。
            Log.w(TAG, "Failed to show the WebView upgrade dialog", windowGone);
        }
    }

    /**
     * 把用户送到能更新 WebView 的地方。
     *
     * 一路 startActivity 一路 catch：没有能接住的就换下一条，全接不住才 Toast。
     * 这里不用 resolveActivity 预先判断 —— Android 11 起包可见性会让它一律返回 null，
     * 直接 startActivity 反而不受影响。
     */
    private static void openUpgrade(Activity activity, Info info) {
        String pkg = info.packageName != null && !info.packageName.isEmpty()
                ? info.packageName
                : DEFAULT_WEBVIEW_PACKAGE;

        Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg));
        market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (start(activity, market)) {
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Intent settings = new Intent(Settings.ACTION_WEBVIEW_SETTINGS);
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (start(activity, settings)) {
                return;
            }
        }

        Intent web = new Intent(Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=" + pkg));
        web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (start(activity, web)) {
            return;
        }

        Toast.makeText(activity.getApplicationContext(),
                R.string.webview_upgrade_no_store, Toast.LENGTH_LONG).show();
    }

    private static boolean start(Activity activity, Intent intent) {
        try {
            activity.startActivity(intent);
            return true;
        } catch (ActivityNotFoundException nobodyHandlesIt) {
            return false;
        } catch (SecurityException notAllowed) {
            return false;
        }
    }

    /** 崩溃报告里那一行 webview 信息。 */
    public static String describe(Context context, WebView webView) {
        return inspect(context, webView).describe();
    }
}
