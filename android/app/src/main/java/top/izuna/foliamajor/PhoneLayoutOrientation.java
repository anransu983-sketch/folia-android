package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;

/**
 * 「强制横屏」的方向锁。
 *
 * 只认方向本身：横屏就把 Activity 锁成横屏，其它一律交回系统（UNSPECIFIED，
 * 跟着传感器转）。
 *
 * **不再看「手机布局」那个总开关** —— 那个开关已经从设置里删掉了，而正是这道门
 * 让「横竖屏兼容」那一行单独打开时毫无反应（用户原话「打开也不生效」）：
 * `isEnabled()` 默认是 false，方向锁于是永远走 UNSPECIFIED 那一支。
 */
final class PhoneLayoutOrientation {
    private static final String PREFS_NAME = "folia_native_prefs";
    private static final String KEY_ENABLED = "phone_fit_enabled";
    private static final String KEY_ORIENTATION = "phone_fit_orientation";
    private static final String MODE_PORTRAIT = "portrait";
    private static final String MODE_LANDSCAPE = "landscape";

    private PhoneLayoutOrientation() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    static String getOrientation(Context context) {
        return normalize(prefs(context).getString(KEY_ORIENTATION, MODE_PORTRAIT));
    }

    static void update(Context context, boolean enabled, String orientation) {
        prefs(context).edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putString(KEY_ORIENTATION, normalize(orientation))
            .apply();
    }

    static void apply(Activity activity) {
        if (activity == null) return;
        /*
         * 只有「强制横屏」这一条会锁方向；关掉就是交回系统，不再有中间那道总开关。
         *
         * SENSOR_LANDSCAPE 而不是 LANDSCAPE：前者允许 180° 转向（手机倒过来拿，
         * 屏幕跟着倒），后者会把它钉死在某一个方向。
         */
        activity.setRequestedOrientation(
            MODE_LANDSCAPE.equals(getOrientation(activity))
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        );
    }

    private static String normalize(String value) {
        return MODE_LANDSCAPE.equals(value) ? MODE_LANDSCAPE : MODE_PORTRAIT;
    }
}
