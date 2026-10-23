package top.izuna.foliamajor;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * 歌词后方「视频层」那个本地视频的落盘副本。
 *
 * 为什么必须拷一份进私有目录（和壁纸视频同一个道理，见 wallpaper/WallpaperBackgroundVideo）：
 *  · WebView 里没有 File System Access API（`showOpenFilePicker`），挑文件只能退回
 *    `<input type=file>` —— 拿到的 File 只够转成 `blob:` 地址，**进程一死就失效**，
 *    于是每次重启都要重挑一遍视频（正是这一层要修的事）；
 *  · `ACTION_OPEN_DOCUMENT` 给的那份读权限随进程一起没，`content://` 也播不了
 *    （WebView 的 <video> 不认它），拿原始 URI 去播就是「重开就没了」。
 *
 * 拷进私有目录之后，这两件事都不再发生：副本跟着 App 走，用户把相册里的原视频删掉也不影响。
 * 代价只是多占一份磁盘，所以这里只留**一个**文件（换一个就删掉上一个）。
 *
 * 视频同样不能走 base64 过桥（动辄几十上百 MB），所以是「原生自己拷、自己喂」：
 * 字节留在这里，Web 侧只拿一个回环地址（LocalAudioServer 的 /video-layer/ 路由）。
 */
public final class VideoLayerFile {

    private static final String TAG = "FoliaVideoLayer";
    private static final String DIRECTORY_NAME = "video-layer";
    /** 固定的文件名（扩展名跟着真身走）：一次只有一个视频，URL 也就永远是同一个。 */
    private static final String BASE_NAME = "layer";
    private static final String PREFERENCES = "folia_video_layer";
    /** 用户看到的名字：文件名是拼出来的、给 URL 用的，两个不是一回事。 */
    private static final String KEY_DISPLAY_NAME = "displayName";
    /** 存下来的扩展名：`file()` 要靠它拼出文件名，而它决定的是喂给 <video> 的 Content-Type。 */
    private static final String KEY_EXTENSION = "extension";
    /** 防御性上限：和壁纸视频一致，超过就直接拒绝，免得拷半天才失败。 */
    private static final long MAX_BYTES = 512L * 1024L * 1024L;

    private VideoLayerFile() {}

    /** 磁盘上这一份（有或没有都返回：文件不存在时 isFile() 为 false）。 */
    public static File file(Context context) {
        if (context == null) return null;
        File dir = directory(context);
        String name = BASE_NAME + storedExtension(context);
        return new File(dir, name);
    }

    private static File directory(Context context) {
        File dir = new File(context.getFilesDir(), DIRECTORY_NAME);
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(TAG, "Could not create the video layer directory");
        }
        return dir;
    }

    /**
     * 把用户挑中的视频拷进私有目录。
     *
     * @return 成功时返回这一份的 key（变了就说明换过视频）；失败返回 null，
     *         旧的那个已经被删掉 —— 宁可没有视频，也不留一个坏的在上面。
     */
    public static String store(Context context, Uri uri, String displayName, String mimeType) {
        if (context == null || uri == null) return null;
        clear(context);
        String extension = extensionFor(mimeType, displayName);
        File target = new File(directory(context), BASE_NAME + extension);
        File temp = new File(directory(context), BASE_NAME + extension + ".part");
        delete(temp);
        File previous = file(context);
        if (previous != null && !previous.equals(target)) delete(previous);
        boolean ok = false;
        try (InputStream in = context.getContentResolver().openInputStream(uri)) {
            if (in == null) {
                Log.w(TAG, "Could not open the chosen video");
                return null;
            }
            long written = 0L;
            byte[] buffer = new byte[256 * 1024];
            try (OutputStream out = new FileOutputStream(temp)) {
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                    written += read;
                    if (written > MAX_BYTES) {
                        Log.w(TAG, "The chosen video is too large");
                        return null;
                    }
                }
            }
            if (written <= 0L) return null;
            ok = temp.renameTo(target);
        } catch (Throwable error) {
            Log.w(TAG, "Failed to copy the chosen video", error);
        } finally {
            if (!ok) delete(temp);
        }
        if (!ok) return null;
        preferences(context)
            .edit()
            .putString(KEY_DISPLAY_NAME, displayName == null || displayName.isEmpty() ? "video" : displayName)
            .putString(KEY_EXTENSION, extension)
            .apply();
        return key(context);
    }

    /** 换没换过的判据：文件长度 + 修改时间（和壁纸那套一致）。没有就返回 null。 */
    public static String key(Context context) {
        File file = file(context);
        if (file == null || !file.isFile() || file.length() <= 0) return null;
        return file.length() + "@" + file.lastModified();
    }

    /** 用户在设置里看到的那个名字（挑的时候的原始文件名）。 */
    public static String displayName(Context context) {
        if (context == null) return null;
        File file = file(context);
        if (file == null || !file.isFile()) return null;
        return preferences(context).getString(KEY_DISPLAY_NAME, "video");
    }

    /** 给 <video> 的 Content-Type。按扩展名推：这一层只放我们自己拷进来的那一个文件。 */
    public static String mimeType(Context context) {
        if (context == null) return "video/mp4";
        return mimeOf(storedExtension(context));
    }

    public static void clear(Context context) {
        if (context == null) return;
        File dir = directory(context);
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) delete(child);
        }
        preferences(context).edit().clear().apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static String storedExtension(Context context) {
        String stored = preferences(context).getString(KEY_EXTENSION, null);
        return stored == null || stored.isEmpty() ? ".mp4" : stored;
    }

    /**
     * 扩展名按 ContentResolver 报的类型定，名字只作兜底。
     *
     * 为什么不直接用原始文件名：名字里的空格、中文、emoji 进 URL 都要转义，而扩展名
     * 决定的是 Content-Type —— 报 `video/webm` 却存成 `.mp4`，播放器拿到的类型就错了。
     */
    private static String extensionFor(String mimeType, String displayName) {
        String mime = mimeType == null ? "" : mimeType.toLowerCase(Locale.ROOT);
        if (mime.contains("webm")) return ".webm";
        if (mime.contains("mp4") || mime.contains("m4v")) return ".mp4";
        if (mime.contains("quicktime")) return ".mov";
        if (mime.contains("ogg")) return ".ogv";
        if (mime.contains("matroska")) return ".mkv";
        if (mime.contains("x-ms-wmv") || mime.contains("x-msvideo")) return ".wmv";
        if (mime.contains("3gpp")) return ".3gp";
        String name = displayName == null ? "" : displayName.toLowerCase(Locale.ROOT);
        int dot = name.lastIndexOf('.');
        String fromName = dot >= 0 ? name.substring(dot) : "";
        if (isKnownVideoExtension(fromName)) return fromName;
        return ".mp4";
    }

    private static boolean isKnownVideoExtension(String extension) {
        return ".mp4".equals(extension) || ".m4v".equals(extension) || ".webm".equals(extension)
            || ".mov".equals(extension) || ".ogv".equals(extension) || ".mkv".equals(extension)
            || ".wmv".equals(extension) || ".3gp".equals(extension);
    }

    private static String mimeOf(String extension) {
        String lower = extension == null ? "" : extension.toLowerCase(Locale.ROOT);
        if (".webm".equals(lower)) return "video/webm";
        if (".mov".equals(lower)) return "video/quicktime";
        if (".ogv".equals(lower)) return "video/ogg";
        if (".mkv".equals(lower)) return "video/x-matroska";
        if (".wmv".equals(lower)) return "video/x-ms-wmv";
        if (".3gp".equals(lower)) return "video/3gpp";
        return "video/mp4";
    }

    private static void delete(File file) {
        try {
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "Failed to delete " + file.getName());
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Failed to delete " + file.getName(), error);
        }
    }
}
