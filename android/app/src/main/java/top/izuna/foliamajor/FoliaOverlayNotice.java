package top.izuna.foliamajor;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.AlphaAnimation;
import android.view.animation.Animation;
import android.view.animation.AnimationSet;
import android.view.animation.TranslateAnimation;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;

// android/app/src/main/java/top/izuna/foliamajor/FoliaOverlayNotice.java
//
// 后台播放提示的**悬浮条**：样子照 Web 层那条提示（StatusToast）来，但贴在**屏幕下边** ——
// 后台这一条是画在别的应用上面的，压住别人顶部的状态栏/通知比压住底部那条手势条更招人烦。
// 左右留边、水平居中的一条圆角条，只有一行字、**没有按钮**（后台是自动跳过，按钮既点不到
// 也没有意义）。
//
// 为什么不用系统 Toast：Android 11 起后台**不允许**弹自定义 view 的 Toast，只剩下
// 纯文本那条路，于是「和系统画的一样」根本做不到。悬浮窗（SYSTEM_ALERT_WINDOW）
// 能画我们自己的样子，代价是用户要先在系统设置里授权 —— 没授权就退回原来的系统
// Toast（回退在渲染层的 backgroundFailureNotice 里做，这里只回答「挂上去没有」）。
//
// ⚠ 三点必须记住：
//   1. 所有 WindowManager 调用都在**主线程**（Capacitor 的插件方法跑在它自己的
//      HandlerThread 上，直接 addView 会抛并且会让进程死 —— 见 FoliaNativePlugin
//      里其它有线程归属的原生对象）。
//   2. 上下文用 **Application**：提示是在 Activity 已经 stop 之后弹的，抓着 Activity
//      会把它整个泄漏，而且那扇窗口随时可能已经没了。
//   3. ⭐⭐**摘窗口不能只靠动画回调**：早先把 removeView 只挂在出场动画的
//      onAnimationEnd 上，回调一不落（ROM 不派发、窗口令牌中途失效、动画被系统掐掉）
//      那条就**永远留在屏幕上**，表现正是「它出现了就不会消失」。现在动画只是好看，
//      真正的摘除另有一条到点的兜底（见 hide 里的 postDelayed），而且是幂等的。

public final class FoliaOverlayNotice {
    private static final String TAG = "FoliaOverlayNotice";

    /** 摘除已经做过了的标记：动画回调与定时兜底两路都会走到，只能真的摘一次。 */
    private static final Object REMOVED = new Object();

    // 贴底：与网页那条同一组数，只是翻到下面来 —— 离底边 30dp，再让开安全区（手势条）。
    private static final int BOTTOM_MARGIN_DP = 30;
    private static final int SIDE_MARGIN_DP = 16;
    private static final int MAX_WIDTH_DP = 640;
    private static final int RADIUS_DP = 22;
    private static final int PAD_V_DP = 9;
    private static final int PAD_H_DP = 16;
    private static final int TEXT_SP = 14;
    private static final int MAX_LINES = 2;

    private static final long IN_MS = 320;
    private static final long OUT_MS = 220;
    /** 动画该跑完的时间；过了这一刻还没摘掉就直接摘（回调不落时的兜底）。 */
    private static final long OUT_GRACE_MS = OUT_MS + 200;
    private static final long DEFAULT_DURATION_MS = 4000;

    private static final Runnable AUTO_HIDE = FoliaOverlayNotice::hide;

    private static View current;
    private static Handler mainHandler;

    private FoliaOverlayNotice() {
    }

    /** 这一支有没有「画在别的应用上面」的授权。没授权时调用方该去用系统 Toast。 */
    public static boolean canDraw(Context context) {
        if (context == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                return Settings.canDrawOverlays(context);
            } catch (Throwable error) {
                Log.w(TAG, "canDrawOverlays failed", error);
                return false;
            }
        }
        // 6.0 以下这个权限是安装时给的。
        return true;
    }

    private static Handler main() {
        if (mainHandler == null) mainHandler = new Handler(Looper.getMainLooper());
        return mainHandler;
    }

    /** 底部安全区（dp）：手势条那一条，与网页用的 --folia-safe-area-bottom 同源。 */
    private static int safeBottomDp() {
        try {
            JSObject insets = FoliaNativePlugin.peekPhoneInsets();
            return insets == null ? 0 : insets.optInt("bottom", 0);
        } catch (Throwable error) {
            return 0;
        }
    }

    /**
     * 弹一条悬浮提示。**必须在主线程调用**（插件方法里请自己 post 过来）。
     *
     * 返回 false 表示没挂上去（没授权 / 窗口令牌失效），调用方据此回退。
     * `durationMs` 到点后自己收掉；不传或传 0 用默认的 4 秒。
     */
    public static synchronized boolean show(Context context, String text, long durationMs) {
        final Context app = context == null ? null : context.getApplicationContext();
        if (app == null || text == null || text.trim().isEmpty()) return false;
        if (!canDraw(app)) return false;

        try {
            // 已经有一条在显示时**换字重算时间**，不要叠第二条：连着几首都放不出来时
            // 屏幕上不该一次盖一次地刷屏（与渲染层那 4 秒去重是同一件事的两个面）。
            if (current != null) {
                TextView label = current.findViewWithTag("notice-text");
                if (label != null) label.setText(text);
                scheduleHide(durationMs);
                return true;
            }

            final WindowManager manager = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
            if (manager == null) return false;

            final float density = app.getResources().getDisplayMetrics().density;
            final TextView label = new TextView(app);
            label.setTag("notice-text");
            label.setText(text);
            label.setTextColor(0xFFFFFFFF);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, TEXT_SP);
            label.setMaxLines(MAX_LINES);
            // 网页那条的正文字重是 500（.status-toast-title）。
            label.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            label.setMaxWidth((int) (MAX_WIDTH_DP * density));
            final int padV = (int) (PAD_V_DP * density);
            final int padH = (int) (PAD_H_DP * density);
            label.setPadding(padH, padV, padH, padV);
            // 每行 24sp 的行高，与 Web 上那条（line-height: 24px）一致：
            // 14sp 的字本身占不满 24，补上这 10sp 的间距就是那个行高。
            label.setLineSpacing((int) (10 * app.getResources().getDisplayMetrics().scaledDensity), 1f);
            label.setBackground(noticeBackground(density));

            final FrameLayout wrap = new FrameLayout(app);
            wrap.setPadding((int) (SIDE_MARGIN_DP * density), 0, (int) (SIDE_MARGIN_DP * density), 0);
            wrap.setClipChildren(false);
            final FrameLayout.LayoutParams inner = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            inner.gravity = Gravity.CENTER_HORIZONTAL;
            wrap.addView(label, inner);

            final WindowManager.LayoutParams params = new WindowManager.LayoutParams();
            params.type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_PHONE;
            // 不吃点击：它只是「说一句话」，点它跟点它盖住的那一层是同一回事
            // （Web 上那条不带按钮时也是 pointer-events 只在自己身上）。
            params.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                    | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                    | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
            params.format = android.graphics.PixelFormat.TRANSLUCENT;
            params.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
            // 离底边 30dp **再加**底部安全区：贴在手势条上面的话既挡手势也容易被系统收走。
            // 取的是和网页同一份数（PhoneFitCutout 量出来推给网页的那个，CSS px = dp）。
            params.y = (int) ((BOTTOM_MARGIN_DP + safeBottomDp()) * density);
            params.width = WindowManager.LayoutParams.MATCH_PARENT;
            params.height = WindowManager.LayoutParams.WRAP_CONTENT;

            manager.addView(wrap, params);
            current = wrap;
            wrap.startAnimation(enterAnimation(density));
            scheduleHide(durationMs);
            return true;
        } catch (Throwable error) {
            // 窗口令牌失效 / 权限被撤 / ROM 不给画：一律当没弹出来，让调用方回退。
            Log.w(TAG, "the overlay notice could not be shown", error);
            current = null;
            return false;
        }
    }

    /**
     * 收掉当前这一条（如果有）。
     *
     * ⭐出场动画**只是好看**：真正的摘除由 {@link #removeNow} 完成，而它到点那一刻一定会走
     * —— 动画回调（onAnimationEnd）与定时兜底两条路都指向它，谁先到谁摘，后到的被
     * REMOVED 标记挡掉。少了这条兜底，回调不落时提示就永远留在屏幕上。
     */
    public static synchronized void hide() {
        final View view = current;
        if (view == null) return;
        current = null;
        main().removeCallbacks(AUTO_HIDE);

        final float density = view.getResources().getDisplayMetrics().density;
        Animation out = outAnimation(density);
        out.setAnimationListener(new Animation.AnimationListener() {
            @Override public void onAnimationStart(Animation animation) {
            }

            @Override public void onAnimationEnd(Animation animation) {
                removeNow(view);
            }

            @Override public void onAnimationRepeat(Animation animation) {
            }
        });
        try {
            view.startAnimation(out);
        } catch (Throwable error) {
            removeNow(view);
        }
        // 兜底：动画这一路出了任何岔子（回调不派发、动画被掐），到点也一定摘掉。
        main().postDelayed(() -> removeNow(view), OUT_GRACE_MS);
    }

    /** 摘窗口。**幂等**：动画回调与定时兜底都会走到这里，只能真的摘一次。 */
    private static void removeNow(View view) {
        if (view.getTag() == REMOVED) return;
        view.setTag(REMOVED);
        try {
            final Context app = view.getContext().getApplicationContext();
            final WindowManager manager = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
            if (manager != null) manager.removeView(view);
        } catch (Throwable error) {
            Log.w(TAG, "removing the overlay notice failed", error);
        }
    }

    private static void scheduleHide(long durationMs) {
        main().removeCallbacks(AUTO_HIDE);
        main().postDelayed(AUTO_HIDE, durationMs > 0 ? durationMs : DEFAULT_DURATION_MS);
    }

    /**
     * 条子的底：圆角 22dp + 一道 8% 白的边。
     *
     * ⚠ Web 那条是「10% 白的玻璃 + 背后模糊」，模糊在悬浮窗里做不到（背后画的是别的
     * 应用的画面，拿不到那一层），而背景是什么颜色也完全由当时屏幕上是什么决定。
     * 所以这里换成较深的底 —— 换的是可读性，形状、行高、字号、圆角全照搬。
     */
    private static GradientDrawable noticeBackground(float density) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setCornerRadius(RADIUS_DP * density);
        drawable.setColor(0xF2131317);
        drawable.setStroke(Math.max(1, (int) density), 0x14FFFFFF);
        return drawable;
    }

    /** 从下方 18dp 处淡入（与网页那条同一个数，方向翻过来）。 */
    private static Animation enterAnimation(float density) {
        AnimationSet set = new AnimationSet(false);
        AlphaAnimation alpha = new AlphaAnimation(0f, 1f);
        TranslateAnimation move = new TranslateAnimation(0f, 0f, 18f * density, 0f);
        set.addAnimation(alpha);
        set.addAnimation(move);
        set.setDuration(IN_MS);
        set.setInterpolator(new android.view.animation.DecelerateInterpolator(1.6f));
        return set;
    }

    /** 往下 10dp 淡出。 */
    private static Animation outAnimation(float density) {
        AnimationSet set = new AnimationSet(false);
        AlphaAnimation alpha = new AlphaAnimation(1f, 0f);
        TranslateAnimation move = new TranslateAnimation(0f, 0f, 0f, 10f * density);
        set.addAnimation(alpha);
        set.addAnimation(move);
        set.setDuration(OUT_MS);
        set.setInterpolator(new android.view.animation.AccelerateInterpolator(1.4f));
        return set;
    }
}
