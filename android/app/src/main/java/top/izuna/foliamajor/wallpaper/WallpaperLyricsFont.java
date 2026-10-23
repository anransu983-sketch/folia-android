package top.izuna.foliamajor.wallpaper;

import android.content.Context;
import android.graphics.Typeface;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 壁纸歌词的自选字体。
 *
 * 渲染器原先写死了 sans-serif，用户没法换。字体文件不进 SharedPreferences、
 * 也不在歌词状态里传 base64 —— 一个中文字体动辄好几 MB，桥上过一趟不现实，
 * localStorage 也装不下。做法与背景图一致：**只落一个文件**，文件本身就是持久化，
 * 状态里只留一个 key（长度 + 修改时间），渲染器按 key 变化重新加载 Typeface。
 */
public final class WallpaperLyricsFont {

    private static final String TAG = "FoliaWallpaper";
    /** 「单独」模式那份：用户用系统文件选择器挑的。 */
    private static final String FILE_CUSTOM = "folia_wallpaper_font.ttf";
    /**
     * 「跟随播放页」那份：网页把播放页那个字体的字节托管过来的。
     *
     * 分两个文件是必须的：共用一个的话，切到「跟随」会把用户自己挑的字体删掉，
     * 切回来还得重新挑一遍（而且设置里「已选字体」会静默变成没选）。
     */
    private static final String FILE_FOLLOW = "folia_wallpaper_font_follow.ttf";

    private WallpaperLyricsFont() {}

    private static File file(Context context) {
        return new File(context.getFilesDir(), FILE_CUSTOM);
    }

    private static File followFile(Context context) {
        return new File(context.getFilesDir(), FILE_FOLLOW);
    }

    /**
     * 此刻该读哪一份。
     *
     * 判据是「字体来路」那个开关（wp.lyricsFontCustom）。缺这个 key（还没推过配置）
     * 时按「单独」处理：老用户自己挑过的字体不该悄悄失效。
     */
    public static File activeFile(Context context) {
        java.util.Map<String, Float> tuning = WallpaperLyricsState.tuning();
        Float custom = tuning == null ? null : tuning.get("wp.lyricsFontCustom");
        boolean isCustom = custom == null || custom >= 0.5f;
        return isCustom ? file(context) : followFile(context);
    }

    /** 写入（或清除）「单独」那份；返回它的 key，没有时返回 null。 */
    public static String store(Context context, String base64) {
        return write(context, file(context), base64, "c");
    }

    /** 写入（或清除）「跟随播放页」那份：网页托管过来的字节。 */
    public static String storeFollow(Context context, String base64) {
        return write(context, followFile(context), base64, "f");
    }

    private static String write(Context context, File file, String base64, String slot) {
        if (context == null) {
            return null;
        }
        if (base64 == null || base64.trim().isEmpty()) {
            delete(file);
            return null;
        }
        boolean written = false;
        try {
            byte[] bytes = decode(base64);
            if (bytes != null && bytes.length > 0) {
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                    written = true;
                }
            }
        } catch (IOException | RuntimeException error) {
            Log.w(TAG, "Failed to persist the wallpaper lyrics font", error);
        }
        return verify(context, file, written, slot);
    }

    /**
     * 从系统文件选择器给的 URI 直接拷进私有目录。
     *
     * 一个中文字体动辄好几 MB，转成 base64 再过 Capacitor 的桥不现实（又慢又占内存），
     * 所以让用户用系统的文件选择器选，原生拿到 URI 自己拷。
     */
    public static String copyFrom(Context context, Uri uri) {
        if (context == null || uri == null) {
            return null;
        }
        File file = file(context);
        return copyInto(context, file, uri, "c");
    }

    private static String copyInto(Context context, File file, Uri uri, String slot) {
        boolean written = false;
        InputStream input = null;
        try {
            input = context.getContentResolver().openInputStream(uri);
            if (input != null) {
                try (FileOutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                    }
                    written = true;
                }
            }
        } catch (IOException | RuntimeException error) {
            Log.w(TAG, "Failed to copy the chosen lyrics font", error);
        } finally {
            if (input != null) {
                try {
                    input.close();
                } catch (IOException ignored) {
                    // 关闭失败不影响结果。
                }
            }
        }
        return verify(context, file, written, slot);
    }

    /**
     * 拷完/写完之后做一次校验：用户可能选错文件（.zip、.txt 甚至视频）。
     * 这时把文件删掉并当没设过，避免「设置里显示已选字体，壁纸却还是系统字体」的错觉。
     */
    private static String verify(Context context, File file, boolean written, String slot) {
        if (!written) {
            delete(file);
            return null;
        }
        if (loadFile(file) == null) {
            Log.w(TAG, "The chosen lyrics font is not a usable font file, dropping it");
            delete(file);
            return null;
        }
        /*
         * key 带上槽位前缀：两份文件碰巧同长度同修改时间时（极小的概率，但换字体
         * 时真撞上就是「改了不生效」），渲染器会以为没换过而不重新加载。
         */
        return slot + ":" + file.length() + "@" + file.lastModified();
    }

    /** 字体换没换过的判据：槽位 + 文件长度 + 修改时间。 */
    public static String key(Context context) {
        if (context == null) {
            return null;
        }
        return keyOf(null, activeFile(context));
    }

    private static String keyOf(String slot, File file) {
        if (file == null || !file.exists() || file.length() <= 0) {
            return null;
        }
        String prefix = slot == null
                ? (file.getName().endsWith("_follow.ttf") ? "f" : "c")
                : slot;
        return prefix + ":" + file.length() + "@" + file.lastModified();
    }

    /**
     * 读回字体。文件可能不是合法字体（用户选错了文件），那时返回 null，
     * 渲染器回落到系统 sans-serif，不让整个壁纸跟着崩。
     */
    public static Typeface load(Context context) {
        if (context == null) {
            return null;
        }
        return loadFile(activeFile(context));
    }

    /**
     * 读一份字体文件。
     *
     * 读哪一份由「字体来路」那个开关决定（见 activeFile）。来路是**写**那一侧的事，
     * 读这里只看文件本身 —— 早先我在这里按模式挡了一次是错的：`store()` 写完会调
     * `verify()` → `load()`，挡一下等于「推下来的字体被判成坏文件、当场删掉」。
     */
    private static Typeface loadFile(File file) {
        if (file == null || !file.exists()) {
            return null;
        }
        try {
            Typeface typeface = Typeface.createFromFile(file.getAbsolutePath());
            // createFromFile 对坏文件不抛异常，而是回落到默认字体；用它自己比一次即可识别。
            if (typeface == null || typeface.equals(Typeface.DEFAULT)) {
                return null;
            }
            return typeface;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to load the wallpaper lyrics font", error);
            return null;
        }
    }

    private static void delete(File file) {
        try {
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "Failed to delete the wallpaper lyrics font");
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Failed to delete the wallpaper lyrics font", error);
        }
    }

    private static byte[] decode(String base64) {
        try {
            int comma = base64.indexOf(',');
            String payload = comma >= 0 ? base64.substring(comma + 1) : base64;
            return Base64.decode(payload, Base64.DEFAULT);
        } catch (Throwable error) {
            Log.w(TAG, "Failed to decode the wallpaper lyrics font", error);
            return null;
        }
    }
}
