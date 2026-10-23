package top.izuna.foliamajor;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.util.Log;
import android.view.DisplayCutout;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * 适配手机厂商的屏幕顶部显示（挖孔 / 刘海 / 曲面），让界面真正铺满整块屏幕。
 *
 * 只开 cutout 模式不够，实测（0.7.15-android.46 诊断）会出现：
 *   screen=2800  decor=2800  content=2696  safeInset.top=104
 * 窗口已经铺满，但内容视图被系统 inset 顶下来一条，黑边就是它。
 *
 * 所以这里做完整的一套：
 * 1. layoutInDisplayCutoutMode = shortEdges，允许窗口覆盖挖孔；
 * 2. FLAG_LAYOUT_NO_LIMITS + setDecorFitsSystemWindows(false)，不再为系统栏留位；
 * 3. 状态栏/导航栏透明（可见性另归 MainActivity 管）；
 * 4. 给内容根视图挂 inset 监听，把系统栏 inset 从 padding 里清掉（第 4 步才是黑边的直接原因）。
 *
 * 这套适配不跟「手机适配」开关绑定：挖孔是设备固有特征。布局仍由应用内的安全区变量避让。
 */
final class PhoneFitCutout {
    private static final String TAG = "FoliaPhoneFitCutout";
    private static final String INSET_LISTENER_TAG = "folia-cutout-inset-listener";
    private static final String DECOR_PADDING_GUARD_TAG = "folia-cutout-decor-padding-guard";
    private static final String CONTENT_PADDING_GUARD_TAG = "folia-cutout-content-padding-guard";
    private static final String CHAIN_GUARD_TAG = "folia-cutout-chain-guard";
    private static final String CHAIN_ISOLATION_TAG = "folia-cutout-chain-isolation";

    /** 拉锯战的短路窗口：这段窗口里纠正超过上限就停手，宁可留着黑条也不能一直抖。 */
    private static final long CHAIN_GUARD_WINDOW_MS = 2000L;
    private static final int CHAIN_GUARD_MAX_ROUNDS = 3;
    private static volatile long chainGuardWindowStart = 0L;
    private static volatile int chainGuardRounds = 0;

    private PhoneFitCutout() {
    }

    /**
     * 应用「几何上铺满」这一半：启动、回前台、获焦、转屏时都会调用。
     *
     * 这里**刻意不动系统栏的可见性** —— 可见性统一由
     * {@link MainActivity#applyImmersiveMode} 按 Web 层的指令切换。两处都压会打架：
     * 本方法在布局回填时会被反复调用（见 installDecorPaddingGuard），它若压 hide，
     * 就会把「离开歌词页后恢复状态栏」直接覆盖掉，状态栏再也回不来。
     *
     * 而栏显不显也不影响这一层的测量 —— 用的是 `getInsetsIgnoringVisibility`，
     * 量的是「它会占多少」而不是「现在占了没」，所以安全区变量不受开关影响。
     */
    static boolean apply(Activity activity) {
        if (activity == null) {
            return false;
        }
        try {
            Window window = activity.getWindow();
            if (window == null) {
                return false;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams attributes = window.getAttributes();
                // 用 ALWAYS，不用 SHORT_EDGES：
                // · OPPO 官方 Android 15 兼容文档（open.oppomobile.com page/info?id=13047）明确
                //   「非浮窗必须配置 ALWAYS，这是唯一允许的选项」，SHORT_EDGES 属于「未适配」，
                //   部分 ColorOS 实现会按它把窗口排在挖孔/状态栏下方 —— 反馈里的「OPPO 顶部黑条」
                //   正是这个画像（别的机型 SHORT_EDGES 照样铺满，所以只有 OPPO 挂）。
                // · AOSP 15+（targetSdk 35+ 强制边到边）本来也会把 SHORT_EDGES 解释成 ALWAYS，
                //   显式写 ALWAYS 只是把这个语义提前到 15 之前的机器上，不改变 15+ 的行为。
                // 挖孔量得到的 inset（含横屏左右）照常进安全区变量，CSS 那套继续避让。
                attributes.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
                window.setAttributes(attributes);
            }
            // 不再为系统栏留位。
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
            // 系统栏透明，避免顶部出现一条不透明色带。
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);

            View decor = window.getDecorView();
            if (decor != null) {
                decor.setBackgroundColor(0xFF09090B);
                // 部分 ROM 会把 inset 写进 decor 的 padding，清掉它窗口才真的铺到顶。
                decor.setPadding(0, 0, 0, 0);
            }
            applyEdgeToEdge(activity, decor, window);
            // 铺满策略一变（启动、转屏、回前台），安全区就得重新发给网页。
            FoliaNativePlugin.publishPhoneInsets(activity);
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "apply cutout mode failed", error);
            return false;
        }
    }

    /**
     * 清掉内容根视图上的系统栏 inset。
     *
     * 实测 content 比 screen 少一条 safeInset.top，就是这里垫出来的：系统把「状态栏/挖孔」
     * 的 inset 落成了根视图 padding。主动消费掉 systemBars 的 inset 并清空 padding，内容才会
     * 真的延伸到顶部。监听器常驻，重新布局或系统栏临时划出后再回来也不会反弹。
     */
    @SuppressWarnings("deprecation")
    private static void applyEdgeToEdge(Activity activity, View decor, Window window) {
        if (decor == null) {
            return;
        }
        // ① decor 自己会被系统垫 top padding（实测 104px，等于挖孔 safeInset.top）。
        //    这里既清一次，也挂布局监听：系统每次重新布局回填时立刻压回 0。
        clearDecorPadding(decor);
        installDecorPaddingGuard(decor);
        // ② 同步改写 decor 收到的 insets：把 systemBars 归零，系统就不会再按 inset 垫 padding。
        installDecorInsetListener(activity, decor);
        // ③ 整条链的强制铺满：ColorOS / OriginOS 会在布局期把 inset 回填成**任意一层**的
        //    padding（不一定重新派发 inset），decor 与内容根两个守卫盖不满全链。
        //    先断根（isolateChainFromInsets），再挂/续布局守卫（installFullscreenChainGuard）。
        isolateChainFromInsets(decor);
        installFullscreenChainGuard(activity);
        View root = decor;
        if (decor instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) decor;
            if (group.getChildCount() > 0) {
                // decor 的第一个子节点就是承载 Capacitor/WebView 的内容根。
                root = group.getChildAt(0);
            }
        }
        final View contentRoot = root;
        if (contentRoot == null) {
            return;
        }
        contentRoot.setTag(INSET_LISTENER_TAG.hashCode(), Boolean.TRUE);
        installContentPaddingGuard(contentRoot);
        ViewCompat.setOnApplyWindowInsetsListener(contentRoot, (view, insets) -> {
            // 清掉容器链上的 inset padding：黑边就是它垫出来的。
            clearInsetPadding(view, 3);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                // 返回消费掉 systemBars 的 inset，避免系统再垫回来。
                return new WindowInsetsCompat.Builder(insets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars(),
                        androidx.core.graphics.Insets.NONE
                    )
                    .build();
            }
            return insets;
        });
        // 监听器只在 inset 变化时触发；挂上后再主动清一次，启动首帧就不会先闪一条。
        clearInsetPadding(contentRoot, 3);
        ViewCompat.requestApplyInsets(contentRoot);
    }

    /**
     * 内容根（decor 第一个子节点，Capacitor/WebView 的宿主容器）的布局期 padding 守卫。
     *
     * decor 那层已有 {@link #installDecorPaddingGuard}，但内容根这层只在 inset 派发时清一次
     * （inset 监听 + apply 时的 clearInsetPadding）。ColorOS 一类 ROM 会在**重新布局**时把
     * 状态栏 inset 直接回填成内容根的 padding，而不重新派发 inset —— 监听器拦不住，apply 也
     * 不是每次布局都跑，于是顶部就长期留一条（窗口其实已经铺满，垫出来的是 padding）。
     * 挂布局守卫，每次布局发现非 0 就压回 0；只在确实有 padding 时才写，避免触发死循环。
     */
    private static void installContentPaddingGuard(final View contentRoot) {
        if (contentRoot == null
            || contentRoot.getTag(CONTENT_PADDING_GUARD_TAG.hashCode()) != null) {
            return;
        }
        contentRoot.setTag(CONTENT_PADDING_GUARD_TAG.hashCode(), Boolean.TRUE);
        contentRoot.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            if (contentRoot.getPaddingLeft() != 0
                || contentRoot.getPaddingTop() != 0
                || contentRoot.getPaddingRight() != 0
                || contentRoot.getPaddingBottom() != 0) {
                contentRoot.setPadding(0, 0, 0, 0);
            }
        });
    }

    /**
     * WebView → decor 整条链的布局期强制铺满。
     *
     * 反馈现场（OPPO / vivo 都有）：原生量得出 inset（读数 top≈40），但 WebView 实际没画进
     * 状态栏那一条 —— ROM 在**重新布局**时把系统栏 inset 回填成了链上某一层的 padding 或
     * WebView 的边距，不重新派发 inset，inset 监听与 apply 时的一次性清理都拦不住。
     * 链就四层（decor → 内容根 → content → CoordinatorLayout → WebView），与其层层设守卫，
     * 不如从 WebView 往上一次清干净，再把 WebView 自己的 LayoutParams 压成满幅零边距。
     *
     * 只在确实有偏差时才写，避免监听器自己触发新的布局形成死循环；健康机型上恒为无操作。
     *
     * 加了**短路**：只事后清不给源头断根的话，会和系统打拉锯战 —— 我们清完触发重布局，
     * 系统（fitsSystemWindows 那条路）在布局里又把 inset 写回 padding，下一帧我们再清……
     * 帧率级别的来回就是用户看到的「抽搐：一会上面没有，一会下面没有」。
     * 所以一来把源头掐掉（isolateChainFromInsets），二来窗口内纠正超过上限就停手：
     * 宁可在个别机型上留着黑条，也不能让画面一直抖。
     */
    private static void installFullscreenChainGuard(final Activity activity) {
        View decor = activity == null || activity.getWindow() == null
            ? null
            : activity.getWindow().getDecorView();
        if (decor == null || decor.getTag(CHAIN_GUARD_TAG.hashCode()) != null) {
            return;
        }
        decor.setTag(CHAIN_GUARD_TAG.hashCode(), Boolean.TRUE);
        decor.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            long now = android.os.SystemClock.uptimeMillis();
            if (now - chainGuardWindowStart > CHAIN_GUARD_WINDOW_MS) {
                chainGuardWindowStart = now;
                chainGuardRounds = 0;
            }
            if (chainGuardRounds >= CHAIN_GUARD_MAX_ROUNDS) {
                return;
            }
            if (enforceWebViewFullscreen(decor)) {
                chainGuardRounds += 1;
            }
        });
    }

    /**
     * 断根：让 WebView → decor 这条链上的容器**不再自己消费 inset 生成 padding**。
     *
     * 前面那些清理都是事后补救，而「系统每逢布局就把 inset 写成 padding」的根子在这里：
     * `fitsSystemWindows` 为真的 View 会在 dispatchApplyWindowInsets 里领走自己那一份
     * inset 并落成 padding。把链上每层都关掉、并在派发层把 systemBars 吃掉，
     * 系统就没有可落的位置了 —— 之后重布局不会再回填，拉锯战自然停。
     *
     * decor 自己不在这里动：它的监听（`installDecorInsetListener`）还兼着「inset 变了
     * 就重新推给网页」这件事，替换掉会让安全区再也不更新。所以这条链走到 decor 为止。
     */
    private static void isolateChainFromInsets(View decor) {
        if (decor == null) {
            return;
        }
        WebView webView = findWebView(decor);
        for (View node = webView; node != null && node != decor; ) {
            if (node.getTag(CHAIN_ISOLATION_TAG.hashCode()) == null) {
                node.setTag(CHAIN_ISOLATION_TAG.hashCode(), Boolean.TRUE);
                node.setFitsSystemWindows(false);
                ViewCompat.setOnApplyWindowInsetsListener(node, (view, insets) -> {
                    if (view.getPaddingLeft() != 0
                        || view.getPaddingTop() != 0
                        || view.getPaddingRight() != 0
                        || view.getPaddingBottom() != 0) {
                        view.setPadding(0, 0, 0, 0);
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        return new WindowInsetsCompat.Builder(insets)
                            .setInsets(
                                WindowInsetsCompat.Type.systemBars(),
                                androidx.core.graphics.Insets.NONE
                            )
                            .build();
                    }
                    return insets;
                });
            }
            node = node.getParent() instanceof View ? (View) node.getParent() : null;
        }
    }

    /**
     * 单次强制：清整链 padding + 把 WebView 压成满幅零边距。
     *
     * @return 是否真的改了东西（= 又和 ROM 打了一回合，给上端做短路计数用）。
     */
    private static boolean enforceWebViewFullscreen(View decor) {
        if (decor == null) {
            return false;
        }
        WebView webView = findWebView(decor);
        if (webView == null) {
            return false;
        }
        boolean changed = false;
        for (View node = webView; node != null; ) {
            if (node.getPaddingLeft() != 0
                || node.getPaddingTop() != 0
                || node.getPaddingRight() != 0
                || node.getPaddingBottom() != 0) {
                node.setPadding(0, 0, 0, 0);
                changed = true;
            }
            node = node.getParent() instanceof View ? (View) node.getParent() : null;
        }
        ViewGroup.LayoutParams params = webView.getLayoutParams();
        if (params instanceof ViewGroup.MarginLayoutParams) {
            ViewGroup.MarginLayoutParams marginParams = (ViewGroup.MarginLayoutParams) params;
            if (marginParams.leftMargin != 0
                || marginParams.topMargin != 0
                || marginParams.rightMargin != 0
                || marginParams.bottomMargin != 0) {
                marginParams.setMargins(0, 0, 0, 0);
                changed = true;
            }
        }
        if (params.width != ViewGroup.LayoutParams.MATCH_PARENT
            || params.height != ViewGroup.LayoutParams.MATCH_PARENT) {
            params.width = ViewGroup.LayoutParams.MATCH_PARENT;
            params.height = ViewGroup.LayoutParams.MATCH_PARENT;
            changed = true;
        }
        if (changed) {
            webView.requestLayout();
        }
        return changed;
    }

    /**
     * 清掉 inset 顶下来的 padding。
     *
     * 只处理顶部几层容器与 WebView，不动具体内容控件自己的 padding：这一层是系统/宿主垫 inset
     * 的位置，而卡片、按钮的内边距埋得更深，清多了会破坏布局。
     *
     * @param depth 还能往下走几层；decor → content → layout 三层足够覆盖宿主垫 inset 的位置。
     */
    private static void clearInsetPadding(View view, int depth) {
        if (view == null || depth < 0) {
            return;
        }
        if (view instanceof ViewGroup || view instanceof WebView) {
            view.setPadding(0, 0, 0, 0);
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index += 1) {
                clearInsetPadding(group.getChildAt(index), depth - 1);
            }
        }
    }

    /** decor 自身被系统垫的 top padding；实测正好等于挖孔 safeInset.top。 */
    private static boolean hasDecorPadding(View decor) {
        return decor.getPaddingTop() != 0
            || decor.getPaddingBottom() != 0
            || decor.getPaddingLeft() != 0
            || decor.getPaddingRight() != 0;
    }

    private static void clearDecorPadding(View decor) {
        if (decor != null && hasDecorPadding(decor)) {
            decor.setPadding(0, 0, 0, 0);
        }
    }

    /**
     * 系统每次重新布局都会把 cutout/状态栏的 inset 重新写成 decor 的 padding，
     * 一次性清掉会被立刻回填。挂布局监听，在每次布局发生时压回 0。
     *
     * 只在确实有 padding 时才写，避免监听器自己触发新的布局形成死循环。
     */
    private static void installDecorPaddingGuard(final View decor) {
        if (decor == null || decor.getTag(DECOR_PADDING_GUARD_TAG.hashCode()) != null) {
            return;
        }
        decor.setTag(DECOR_PADDING_GUARD_TAG.hashCode(), Boolean.TRUE);
        decor.getViewTreeObserver().addOnGlobalLayoutListener(() -> clearDecorPadding(decor));
    }

    /**
     * 改写 decor 收到的 window insets，把 systemBars 归零。
     *
     * 这是比「事后清 padding」更根上的做法：系统拿不到 systemBars 的 inset，就不会再按它
     * 垫 padding。两者一起用，兼容那些不走 setOnApplyWindowInsetsListener 的 ROM。
     */
    @SuppressWarnings("deprecation")
    private static void installDecorInsetListener(final Activity activity, final View decor) {
        if (decor == null) {
            return;
        }
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            // inset 变了（转屏、系统栏临时划出、挖孔变化）：安全区要重新发给网页。
            FoliaNativePlugin.publishPhoneInsets(activity);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                return new WindowInsetsCompat.Builder(insets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars(),
                        androidx.core.graphics.Insets.NONE
                    )
                    .build();
            }
            return insets;
        });
        ViewCompat.requestApplyInsets(decor);
    }

    /**
     * 真实安全区（CSS px）：系统栏尺寸与挖孔 safeInset，每边取大者。
     *
     * 为什么不能靠网页那边的 `env(safe-area-inset-*)`：
     * · Android WebView 只报告**屏幕缺口（cutout）**，从不报告**系统栏** ——
     *   没有刘海的机器上四项全是 0px，有刘海的也只给刘海高度、不给状态栏高度；
     * · targetSdk 35+（我们是 36）强制边到边，内容确实画到了系统栏下面，
     *   可网页拿到的避让量是 0，于是顶部被状态栏压住、底部被手势条压住；
     * · 国产 ROM 的 WebView 内核常常干脆不透传 env()，旧 Chromium（<140）还会报 0px。
     *
     * 所以这里按 Android 自己那份算出来交给网页：用 `getInsetsIgnoringVisibility`
     * 而不是可见 inset —— 系统栏虽然被隐藏了，用户从边缘一划它就会压回来，
     * 要按「它会占多少」算，不是「现在占了没」。
     */
    static JSONObject resolveInsets(Activity activity) {
        JSONObject result = new JSONObject();
        int top = 0;
        int right = 0;
        int bottom = 0;
        int left = 0;
        try {
            View decor = activity == null || activity.getWindow() == null
                ? null
                : activity.getWindow().getDecorView();
            WindowInsetsCompat insets = decor == null ? null : ViewCompat.getRootWindowInsets(decor);
            if (insets != null) {
                androidx.core.graphics.Insets bars = insets.getInsetsIgnoringVisibility(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                top = Math.max(top, bars.top);
                right = Math.max(right, bars.right);
                bottom = Math.max(bottom, bars.bottom);
                left = Math.max(left, bars.left);
                androidx.core.view.DisplayCutoutCompat cutout = insets.getDisplayCutout();
                if (cutout != null) {
                    top = Math.max(top, cutout.getSafeInsetTop());
                    right = Math.max(right, cutout.getSafeInsetRight());
                    bottom = Math.max(bottom, cutout.getSafeInsetBottom());
                    left = Math.max(left, cutout.getSafeInsetLeft());
                }
            }
        } catch (Throwable error) {
            Log.w(TAG, "resolve insets failed", error);
        }
        // 兜底：上面拿不到（见 resolveStatusBarHeightPx 的说明）时至少把状态栏让出来 ——
        // 顶部那几个控件（LOGO / 搜索框 / 返回）被压住就是这么来的。
        if (top <= 0) {
            top = resolveStatusBarHeightPx(activity);
        }
        float density = 1f;
        if (activity != null) {
            float raw = activity.getResources().getDisplayMetrics().density;
            if (raw > 0f) density = raw;
        }
        try {
            result.put("top", Math.round(top / density));
            result.put("right", Math.round(right / density));
            result.put("bottom", Math.round(bottom / density));
            result.put("left", Math.round(left / density));
        } catch (Throwable error) {
            Log.w(TAG, "describe insets failed", error);
        }
        return result;
    }

    /**
     * 状态栏高度的兜底（物理 px）。
     *
     * 什么时候会走到这里：窗口带了 FLAG_LAYOUT_NO_LIMITS 又处在强制边到边（targetSdk 36），
     * 部分 ROM 直接把 systemBars 的 inset 报成 0，而状态栏其实还在那儿。这时候没有任何
     * inset 可用，只能按系统自己那份 dimen 算。
     *
     * 底部不这么兜：`navigation_bar_height` 是三键导航栏的高度，手势导航的条比它矮得多，
     * 照它让会把底部凭空垫出一大条（就是早先那条「底部白条」的样子）。
     */
    private static int resolveStatusBarHeightPx(Activity activity) {
        if (activity == null) {
            return 0;
        }
        try {
            int id = activity.getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id <= 0) {
                return 0;
            }
            return activity.getResources().getDimensionPixelSize(id);
        } catch (Throwable error) {
            Log.w(TAG, "resolve status bar height failed", error);
            return 0;
        }
    }

    /** 挖孔现场，供诊断报告导出。字段固定为英文。 */
    static JSONObject describe(Activity activity) {
        JSONObject result = new JSONObject();
        try {
            result.put("sdk", Build.VERSION.SDK_INT);
            View decor = activity == null || activity.getWindow() == null
                ? null
                : activity.getWindow().getDecorView();
            if (decor == null) {
                result.put("available", false);
                return result;
            }
            result.put("available", true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                result.put(
                    "layoutInDisplayCutoutMode",
                    activity.getWindow().getAttributes().layoutInDisplayCutoutMode
                );
                WindowInsets insets = decor.getRootWindowInsets();
                DisplayCutout cutout = insets == null ? null : insets.getDisplayCutout();
                result.put("hasCutout", cutout != null);
                if (cutout != null) {
                    result.put(
                        "safeInsets",
                        rect(cutout.getSafeInsetLeft(), cutout.getSafeInsetTop(),
                            cutout.getSafeInsetRight(), cutout.getSafeInsetBottom())
                    );
                    JSONArray rects = new JSONArray();
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        List<Rect> bounding = cutout.getBoundingRects();
                        if (bounding != null) {
                            for (Rect rect : bounding) {
                                rects.put(rect(rect.left, rect.top, rect.right, rect.bottom));
                            }
                        }
                    }
                    result.put("boundingRects", rects);
                }
            }
            // 高度对比：decor 与 WebView 的差值就是还残留的顶部/底部空白。
            android.util.DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
            result.put("screenHeightPx", metrics.heightPixels);
            result.put("decorHeightPx", decor.getHeight());
            View content = decor.findViewById(android.R.id.content);
            result.put("contentHeightPx", content == null ? -1 : content.getHeight());
            WebView webView = findWebView(decor);
            if (webView != null) {
                result.put("webViewHeightPx", webView.getHeight());
                result.put("webViewPaddingTopPx", webView.getPaddingTop());
            }
            if (content != null) {
                result.put("contentPaddingTopPx", content.getPaddingTop());
            }
            result.put(
                "decorPaddingTopPx",
                decor.getPaddingTop()
            );
            android.graphics.Rect windowFrame = new android.graphics.Rect();
            decor.getWindowVisibleDisplayFrame(windowFrame);
            result.put("visibleFrame", rect(windowFrame.left, windowFrame.top, windowFrame.right, windowFrame.bottom));
        } catch (Throwable error) {
            Log.w(TAG, "describe cutout failed", error);
        }
        return result;
    }

    /** 递归找到 WebView，用于诊断它的高度/padding 是否被 inset 顶下来。 */
    private static WebView findWebView(View view) {
        if (view instanceof WebView) {
            return (WebView) view;
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index += 1) {
                WebView found = findWebView(group.getChildAt(index));
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    private static JSONObject rect(int left, int top, int right, int bottom) throws Exception {
        JSONObject rect = new JSONObject();
        rect.put("left", left);
        rect.put("top", top);
        rect.put("right", right);
        rect.put("bottom", bottom);
        return rect;
    }
}
