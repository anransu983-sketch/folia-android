package com.suanran.folia;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.FormBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Spotify 登录的原生桥（FoliaSpotify）。
 *
 * 只做两件 WebView 做不了的事：
 *
 *  · **收 OAuth 回调** —— 桌面端是在 Node 里起 `http://127.0.0.1:5588` 等着 Spotify 把浏览器
 *    送回来（见 electron/spotify/signIn.cjs）。安卓 WebView 起不了服务器，所以由 Java 起。
 *    **端口保持 5588**：内置 client_id 的白名单里就是这一个地址；用户自带 client_id 时也要
 *    把重定向地址填成同一个，所以回调地址永远不变。
 *  · **换 token** —— `accounts.spotify.com/api/token` 从 WebView 里调会撞 CORS。
 *
 * 拿到 access token 之后，取数据（搜索 / 歌单 / 专辑）走公开 Web API，在主 WebView 里
 * 直接 fetch，不再经过原生 —— 所以这里**没有任何取数代码**，登录之外的一切都不归它管。
 *
 * 流程与桌面端逐字对齐（授权码 + PKCE，没有 client secret）：起本地端口 → 开系统浏览器去
 * 同意页 → 浏览器带着 code 回到 5588 → 用 code_verifier 换 token。
 *
 * ⚠️ 桥线程不许被占住：登录要等用户在浏览器里走完，最坏十分钟。所以方法一律异步
 * （`setKeepAlive` + 后台线程收连接 + OkHttp 的 enqueue），等的那段时间里桥是空的 ——
 * 否则其它平台的登录与二维码会集体超时（见 FoliaNativePlugin 那条教训）。
 */
@CapacitorPlugin(name = "FoliaSpotify")
public class FoliaSpotifyPlugin extends Plugin {
    private static final String TAG = "FoliaSpotify";

    /**
     * 内置 client：与桌面端同一个，开源播放器共用的那个桌面客户端身份（见 electron/spotify/signIn.cjs）。
     *
     * 它只是**缺省**：Web 侧在 signIn / refresh 里带了用户自带的 client_id 就用用户的 —— 共用
     * 客户端的限流桶全网共挤（登录成功、读账号连吃 429 出过实证），自带一个就各用各的桶。
     * 流程是 PKCE，没有 client secret 参与，所以换 ID 只换这一个字符串。
     */
    private static final String CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";
    private static final int PORT = 5588;
    private static final String REDIRECT_URI = "http://127.0.0.1:" + PORT + "/login";
    private static final String AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
    private static final String TOKEN_URL = "https://accounts.spotify.com/api/token";
    /** 一次登录最多等这么久，与桌面端一致。 */
    private static final int ATTEMPT_MS = 10 * 60 * 1000;
    /** 换 token 这个请求本身的上限；没有上限就可能永远等下去。 */
    private static final int REQUEST_LIMIT_MS = 30 * 1000;
    /** 桌面端照 librespot 的那份清单要的权限，一个字不改：少要一个，取数就会 403。 */
    private static final String SCOPES =
        "app-remote-control playlist-modify playlist-modify-private playlist-modify-public playlist-read "
            + "playlist-read-collaborative playlist-read-private streaming ugc-image-upload user-follow-modify "
            + "user-follow-read user-library-modify user-library-read user-modify user-modify-playback-state "
            + "user-modify-private user-personalized user-read-birthdate user-read-currently-playing user-read-email "
            + "user-read-play-history user-read-playback-position user-read-playback-state user-read-private "
            + "user-read-recently-played user-top-read";

    /** 浏览器最后停在的那一页。它是这个应用唯一显示在窗口之外的文字。 */
    private static final String PAGE_DONE = "已登录 Spotify，可以回到 Folia 了。";
    private static final String PAGE_REFUSED = "未授权。请回到 Folia 重试。";
    private static final String PAGE_FAILED = "登录未完成。请回到 Folia 重试。";

    private final SecureRandom random = new SecureRandom();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .callTimeout(REQUEST_LIMIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        .build();

    /** 一次只能有一次登录在等：回调地址只有一个。 */
    private ServerSocket listening = null;

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ready", true);
        call.resolve(result);
    }

    /**
     * 起一次登录并等到出结果。
     *
     * 答 `{ ok: true, session: { accessToken, refreshToken, expiresInMs } }`；
     * 没走通（取消 / 拒绝 / 超时 / 端口被占）是 `{ ok: false, error: { code, message } }`
     * —— **不是** reject：reject 到 JS 侧会被统一折成 `unavailable`，真正的原因就没了。
     */
    /** 这次登录用哪个 client：Web 侧带了用户自带的就用它（去空白），没带 / 空白回内置共用的。 */
    private static String clientIdOf(PluginCall call) {
        String custom = call.getString("clientId");
        if (custom != null && !custom.trim().isEmpty()) return custom.trim();
        return CLIENT_ID;
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        stopListening();
        final String clientId = clientIdOf(call);

        final String verifier = base64url(randomBytes(64));
        final String state = base64url(randomBytes(16));
        final String challenge = base64url(sha256(verifier.getBytes(StandardCharsets.UTF_8)));

        final ServerSocket server;
        try {
            server = new ServerSocket(PORT, 1, InetAddress.getByName("127.0.0.1"));
        } catch (IOException | SecurityException error) {
            Log.w(TAG, "could not listen on " + PORT, error);
            // 'cannot-listen' 是桌面端对「端口没起来」用的那个词：界面上那句「端口被占用」
            // 的提示挂在它上面（spotifyProvider.auth.getLoginTexts 的 caseNotes）。
            call.resolve(failure("cannot-listen", "Spotify sign-in could not listen for the answer"));
            return;
        }
        // 等满这一次登录的时间就自己退出，别让端口一直挂着。
        try {
            server.setSoTimeout(ATTEMPT_MS);
        } catch (Exception ignored) {
            // 设不上超时就等下去：下面的 cancel / destroy 仍然收得回来。
        }
        listening = server;

        final String page = AUTHORIZE_URL + "?" + queryOf(new String[][] {
            { "response_type", "code" },
            { "client_id", clientId },
            { "redirect_uri", REDIRECT_URI },
            { "scope", SCOPES },
            { "code_challenge_method", "S256" },
            { "code_challenge", challenge },
            { "state", state },
        });

        call.setKeepAlive(true);
        final AtomicBoolean settled = new AtomicBoolean(false);
        final PluginCall kept = call;

        final Thread thread = new Thread(() -> {
            try {
                while (!settled.get()) {
                    Socket socket;
                    try {
                        socket = server.accept();
                    } catch (SocketTimeoutException expired) {
                        if (settled.compareAndSet(false, true)) {
                            kept.resolve(failure("sign-in-failed", "The Spotify sign-in was not finished in time"));
                        }
                        return;
                    } catch (IOException closed) {
                        // stopListening() 关掉了端口（换了一次登录 / 组件销毁）：不是失败。
                        return;
                    }
                    try {
                        handle(socket, state, verifier, clientId, kept, settled);
                    } catch (IOException ignored) {
                        // 浏览器那边断了（用户切走了、连被重置）：继续等下一次。
                    } finally {
                        close(socket);
                    }
                }
            } finally {
                // 只关自己这一次开的那个端口（见 closeServer 的说明）。
                closeServer(server);
            }
        }, "folia-spotify-signin");
        thread.setDaemon(true);
        thread.start();

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(page));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException error) {
            Log.w(TAG, "no browser to open Spotify's page", error);
            if (settled.compareAndSet(false, true)) {
                // 'browser-unfinished'：桌面端对「浏览器那边没走完」用的那个词，caseNotes 有它。
                kept.resolve(failure("browser-unfinished", "No browser could be opened for the Spotify sign-in"));
            }
            return;
        }
        Log.i(TAG, "sign-in is waiting on 127.0.0.1:" + PORT);
    }

    /** 用 refresh token 换一对新的。 */
    @PluginMethod
    public void refresh(PluginCall call) {
        String refreshToken = call.getString("refreshToken");
        if (refreshToken == null || refreshToken.isEmpty()) {
            call.resolve(failure("auth-required", "Spotify refresh needs the token it gave before"));
            return;
        }
        FormBody.Builder fields = new FormBody.Builder()
            .add("client_id", clientIdOf(call))
            .add("grant_type", "refresh_token")
            .add("refresh_token", refreshToken);
        call.setKeepAlive(true);
        requestTokens(fields, refreshToken, call);
    }

    /**
     * 浏览器回来的那一次请求。
     *
     * 任何人都可能在这个端口开着的时候敲一下（也包括请求行不是合法地址的情况），一律按
     * 「陌生人」答 404，绝不因为解析失败把这次登录判死。
     */
    private void handle(Socket socket, String state, String verifier, String clientId, PluginCall call, AtomicBoolean settled)
        throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        String requestLine = reader.readLine();
        // 请求头读到空行为止：不读完，浏览器会认为这一次响应不完整。
        String header;
        while ((header = reader.readLine()) != null && !header.isEmpty()) { /* drained */ }
        if (requestLine == null || !requestLine.startsWith("GET ")) {
            write(socket, 404, "");
            return;
        }
        String path = requestLine.split(" ")[1];
        int split = path.indexOf('?');
        String pathname = split < 0 ? path : path.substring(0, split);
        if (!"/login".equals(pathname)) {
            write(socket, 404, "");
            return;
        }
        java.util.Map<String, String> query = query(split < 0 ? "" : path.substring(split + 1));

        // state 对不上：多半是上一次登录留在某个标签页里的回答，跟当前这次无关。
        if (!state.equals(query.get("state"))) {
            write(socket, 200, pageOf(PAGE_FAILED));
            return;
        }
        if (!settled.compareAndSet(false, true)) {
            write(socket, 404, "");
            return;
        }
        String code = query.get("code");
        if (code == null || code.isEmpty()) {
            String said = query.get("error");
            String reason = "access_denied".equals(said) ? "access-denied"
                : "server_error".equals(said) ? "unreachable"
                : "temporarily_unavailable".equals(said) ? "asked-to-wait"
                : said != null ? "refused" : "sign-in-failed";
            Log.w(TAG, "sign-in was not completed: " + reason);
            write(socket, 200, pageOf("access-denied".equals(reason) ? PAGE_REFUSED : PAGE_FAILED));
            // 到这里 settled 已经由上面那次 CAS 拿下，直接结掉即可。
            call.resolve(failure(reason, "The Spotify sign-in was not completed"));
            return;
        }
        write(socket, 200, pageOf(PAGE_DONE));
        requestTokens(new FormBody.Builder()
            .add("client_id", clientId)
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("redirect_uri", REDIRECT_URI)
            .add("code_verifier", verifier), null, call);
    }

    /** 换 token。两种情况共用：授权码换第一次，refresh token 换以后每一次。 */
    private void requestTokens(FormBody.Builder fields, String keptRefreshToken, PluginCall call) {
        Request request = new Request.Builder()
            .url(TOKEN_URL)
            .post(fields.build())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .build();
        // enqueue 而不是 execute：等的那段时间必须把桥线程让出来。
        http.newCall(request).enqueue(new okhttp3.Callback() {
            @Override
            public void onFailure(okhttp3.Call httpCall, IOException error) {
                Log.w(TAG, "the token request did not go through", error);
                call.resolve(failure("network", "Spotify could not be reached to issue a token"));
            }

            @Override
            public void onResponse(okhttp3.Call httpCall, Response response) {
                String body = "";
                try {
                    body = response.body() == null ? "" : response.body().string();
                } catch (IOException ignored) {
                    // 读不出来就按下面「没有 access_token」处理。
                } finally {
                    response.close();
                }
                String accessToken = field(body, "access_token");
                // 刷新时 Spotify 可以不给新的 refresh token（它仍然有效），那时留着旧的。
                String refreshToken = field(body, "refresh_token");
                if (refreshToken == null || refreshToken.isEmpty()) refreshToken = keptRefreshToken;
                String error = field(body, "error");
                if (!response.isSuccessful() || accessToken == null || refreshToken == null) {
                    // 授权本身被收回，或者过了 Spotify 给那半年：只能重新登录。
                    if ("invalid_grant".equals(error)) {
                        call.resolve(failure("auth-required", "Spotify no longer accepts the sign-in"));
                        return;
                    }
                    Log.w(TAG, "no token: HTTP " + response.code() + " " + error);
                    call.resolve(failure("invalid-response", "Spotify did not issue a token"));
                    return;
                }
                long seconds = 3600;
                try {
                    seconds = Long.parseLong(field(body, "expires_in"));
                } catch (NumberFormatException | NullPointerException ignored) {
                    // 没给就按一小时算。
                }
                JSObject session = new JSObject();
                session.put("accessToken", accessToken);
                session.put("refreshToken", refreshToken);
                // 提前一分钟到期：宁可早续，也不要在取数的中途撞上过期。
                session.put("expiresInMs", Math.max(60, seconds) * 1000);
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("session", session);
                call.resolve(result);
            }
        });
    }

    /** 从 token 那份 JSON 里取一个字符串字段。不引第三方 JSON：就三个字段，正则足够。 */
    private static String field(String body, String name) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern
            .compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"")
            .matcher(body);
        return matcher.find() ? matcher.group(1) : null;
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

    private void write(Socket socket, int status, String html) throws IOException {
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        OutputStream out = socket.getOutputStream();
        String head = (status == 200
            ? "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
            : "HTTP/1.1 404 Not Found\r\n")
            + "Content-Length: " + body.length + "\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        if (body.length > 0) out.write(body);
        out.flush();
    }

    private static String pageOf(String text) {
        return "<!doctype html><meta charset=\"utf-8\"><title>Folia</title><body style=\"margin:0;display:grid;"
            + "place-items:center;height:100vh;background:#121212;color:#fff;font:16px system-ui,sans-serif\">"
            + text + "</body>";
    }

    private static java.util.Map<String, String> query(String raw) {
        java.util.Map<String, String> map = new java.util.HashMap<>();
        if (raw.isEmpty()) return map;
        for (String pair : raw.split("&")) {
            int split = pair.indexOf('=');
            if (split <= 0) continue;
            map.put(
                URLDecoder.decode(pair.substring(0, split), StandardCharsets.UTF_8),
                URLDecoder.decode(pair.substring(split + 1), StandardCharsets.UTF_8));
        }
        return map;
    }

    private static String queryOf(String[][] pairs) {
        StringBuilder out = new StringBuilder();
        for (String[] pair : pairs) {
            if (out.length() > 0) out.append('&');
            out.append(Uri.encode(pair[0])).append('=').append(Uri.encode(pair[1]));
        }
        return out.toString();
    }

    private byte[] randomBytes(int size) {
        byte[] bytes = new byte[size];
        random.nextBytes(bytes);
        return bytes;
    }

    private static String base64url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is missing", error);
        }
    }

    private static void close(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // 已经断了。
        }
    }

    /**
     * 关掉这一次登录自己开的那个端口。
     *
     * 必须是「哪个端口归谁就关哪个」，不能写成「关掉当前那个」：换一次登录时，上一次那条
     * 收连接的线程是**被关端口这一下唤醒**的，它的 finally 才接着跑 —— 那时字段上已经是
     * 新开的端口了，一句 `listening.close()` 会把新的一次登录一起关掉（表现为第二次登录
     * 永远收不到回调）。所以这里只在字段仍指向自己时才把它清掉。
     */
    private void closeServer(ServerSocket server) {
        if (server == null) return;
        if (listening == server) listening = null;
        try {
            server.close();
        } catch (IOException ignored) {
            // 已经关了。
        }
    }

    private void stopListening() {
        closeServer(listening);
    }

    /**
     * 组件销毁时必须把端口放掉，否则下一次登录会撞「端口已被占用」。
     *
     * 这里**不需要**在 onPause / onStop 里收：用户点了登录之后本来就要离开应用去浏览器，
     * 那时端口必须继续开着等回调 —— 收掉的后果就是「登录走完了，App 这边永远在转」。
     */
    @Override
    protected void handleOnDestroy() {
        stopListening();
    }
}
