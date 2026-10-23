package com.suanran.folia;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * YouTube Music 取流的原生桥（FoliaInnerTube）：冒充 YouTube 官方 App 客户端调
 * InnerTube 的 player 接口，拿 googlevideo 音频直链。
 *
 * 为什么单独一座桥、不并进 {@link FoliaYtmPlugin}：那座的边界写得很明白——原生只负责
 * 「让人登录一次、把 cookie 交出来」，没有任何取数代码。取流是另一件事：它要的不是
 * 浏览器身份而是 App 客户端身份（页内 youtubei.js 的 WEB_REMIX 取流要 poToken，
 * BotGuard 在安卓没有等价生成端），且自带回退链、visitorData 缓存、SAPISID 计算一整套
 * 状态，独立成类才放得下。组织方式与 {@link FoliaSpotifyPlugin} 同构：单平台、单职责、
 * 自带一个 OkHttp。
 *
 * 出口纪律（重要）：取链与取流必须走同一个网络出口——googlevideo 的直链绑请求 IP，
 * 桥若自己另走一条路（自设代理、单独分流），取回来的链喂给播放器就是一张 403。所以
 * 这里的 OkHttp 不设任何代理、跟设备网络栈走；Web 侧拿到直链后也是经同一套原生栈的
 * 回环代理（LocalAudioServer）去取流。选中直链后桥内先自己发一个字节的 Range 请求
 * 自检（见 resolve 里的 egress 检查）：链在原生栈这里就拉不动，就判这一级失败继续
 * 回退，绝不把一条注定 403 的链交出去。
 *
 * 客户端表：版本号 / UA / 设备字段逐字抄本仓锁定的 youtubei.js 18.1.0 的
 * `Constants.CLIENTS`；API key 是各官方 App 内嵌的公开客户端密钥（社区公开记录，
 * 不是任何人的凭据），集中在这一张表里，政策或版本变了只改这一处。回退链与分类
 * 规则的来历见设计稿（innertube-bridge-design.md §2/§5/§6）。
 *
 * 凭据纪律：cookie 只从每次调用的入参来、用完即弃，不落盘、不缓存、不进日志；
 * 日志只记客户端名、itag、失败类别，绝不记直链全文（链里带签名参数）与 cookie。
 */
@CapacitorPlugin(name = "FoliaInnerTube")
public class FoliaInnerTubePlugin extends Plugin {
    private static final String TAG = "FoliaInnerTube";
    private static final MediaType JSON_TYPE = MediaType.get("application/json; charset=utf-8");
    private static final String PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
    private static final String VISITOR_URL = "https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false";
    /** 整条回退链的时间预算：跑满就停，别让一次取址把播放的重试节奏拖死。 */
    private static final long CHAIN_BUDGET_MS = 25_000L;

    /** 一个官方 App 客户端的伪装参数。`route` 是命中时回报给 Web 侧的路线名，进播放日志。 */
    private static final class ClientSpec {
        final String key;          // 桥内与诊断用的名字（ANDROID_VR 等）
        final String route;        // 路线名（小写，进 provider 的日志行）
        final String clientName;   // context.client.clientName 与 X-YouTube-Client-Name 的文本名
        final int clientNameId;    // X-YouTube-Client-Name 的数字 id
        final String clientVersion;
        final String apiKey;
        final String userAgent;
        final String deviceMake;   // 可空
        final String deviceModel;  // 可空
        final String osName;       // 可空
        final String osVersion;    // 可空
        final int androidSdkVersion; // 0 = 不带

        ClientSpec(String key, String route, String clientName, int clientNameId, String clientVersion,
                   String apiKey, String userAgent, String deviceMake, String deviceModel,
                   String osName, String osVersion, int androidSdkVersion) {
            this.key = key;
            this.route = route;
            this.clientName = clientName;
            this.clientNameId = clientNameId;
            this.clientVersion = clientVersion;
            this.apiKey = apiKey;
            this.userAgent = userAgent;
            this.deviceMake = deviceMake;
            this.deviceModel = deviceModel;
            this.osName = osName;
            this.osVersion = osVersion;
            this.androidSdkVersion = androidSdkVersion;
        }
    }

    // API key 是官方 App 内嵌的公开客户端密钥，值取自社区公开记录（yt-dlp 的客户端表）；
    // TV embedded 那把与本仓 Constants 里 WEB 的相同（embed 播放器页 ytcfg 的就是它，已逐字核对）。
    private static final ClientSpec ANDROID_VR = new ClientSpec(
        "ANDROID_VR", "android_vr", "ANDROID_VR", 28, "1.65.10",
        "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
        "Oculus", "Quest 3", "Android", "12L", 32);
    private static final ClientSpec IOS = new ClientSpec(
        "IOS", "ios", "iOS", 5, "20.11.6",
        "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
        "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)",
        "Apple", "iPhone10,4", "iOS", "16.7.7.20H330", 0);
    private static final ClientSpec TV_EMBEDDED = new ClientSpec(
        "TVHTML5_SIMPLY_EMBEDDED_PLAYER", "tv_embedded", "TVHTML5_SIMPLY_EMBEDDED_PLAYER", 85, "2.0",
        "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
        "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
        null, null, null, null, 0);
    private static final ClientSpec ANDROID = new ClientSpec(
        "ANDROID", "android", "ANDROID", 3, "21.03.36",
        "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip",
        null, "SM-S908E", "Android", "16", 36);

    /** 回退链（设计稿 §2.1）：主选 ANDROID_VR，依次 IOS、TV embedded、ANDROID 兜底。 */
    private static final ClientSpec[] CHAIN = { ANDROID_VR, IOS, TV_EMBEDDED, ANDROID };
    /** visitor_id 是网页系端点，用 WEB 客户端的公开参数（版本与 key 逐字抄本仓 Constants）。 */
    private static final String WEB_CLIENT_VERSION = "2.20260623.01.00";
    private static final String WEB_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

    // 与桌面 pickAudioFormat 同一套常量（electron/ytm/ytmApiBridge.cjs）。
    private static final int STANDARD_ITAG = 250;
    private static final long STANDARD_BITRATE = 64_000L;
    private static final long STANDARD_FLOOR_BITRATE = 40_000L;
    private static final int[] ULTRA_ITAGS = { 774, 141 };

    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .build();

    /** 取流串行化：预取与播放可能同时来问，一首一首答，链与 visitorData 都不用抢。 */
    private final ReentrantLock resolveLock = new ReentrantLock();
    /** 匿名 visitorData 缓存（只存内存，冷启重取）；登录那份与 cookie 同源，每次登录链现换、不缓存。 */
    private volatile String anonymousVisitorData;
    /** 最近一次出口自检的结论，给 status()/诊断看：ok / failed(...) / not run。 */
    private volatile String lastEgress = "not run";

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ready", true);
        result.put("visitorData", anonymousVisitorData != null ? "held" : "none");
        result.put("egress", lastEgress);
        call.resolve(result);
    }

    /**
     * 取一首歌的音频直链。
     *
     * 入参 `{ videoId, quality, session: { cookie, userAgent } | null, allowSignedIn }`；
     * 成功答 `{ ok: true, stream: { url, itag, bitrate, mimeType, contentLength, level, route, clientUsed, expiresAt } }`；
     * 失败答 `{ ok: false, error: { code, message, attempts: [{ client, code, detail }] } }`
     * —— **不是** reject（同 FoliaYtm 的规矩：reject 会被 JS 侧折成 unavailable、丢掉分类）。
     * code 是桥内小分类（rate-limited / login-required / not-playable / region-restricted /
     * formats / egress-blocked / network / invalid-response），由 JS 侧映射回既有错误分类。
     */
    @PluginMethod
    public void resolveStream(PluginCall call) {
        String videoId = call.getString("videoId");
        String quality = call.getString("quality");
        if (videoId == null || !videoId.matches("[\\w-]{11}")) {
            call.resolve(failure("invalid-response", "A valid video id is needed", new ArrayList<>()));
            return;
        }
        if (!"standard".equals(quality) && !"high".equals(quality) && !"ultra".equals(quality)) {
            quality = "high";
        }
        JSObject sessionObject = call.getObject("session");
        Session session = null;
        if (sessionObject != null) {
            String cookie = sessionObject.getString("cookie");
            String userAgent = sessionObject.getString("userAgent");
            if (cookie != null && !cookie.isEmpty()) session = new Session(cookie, userAgent == null ? "" : userAgent);
        }
        boolean allowSignedIn = Boolean.TRUE.equals(call.getBoolean("allowSignedIn", false));

        resolveLock.lock();
        try {
            call.resolve(resolve(videoId, quality, session, allowSignedIn));
        } catch (RuntimeException error) {
            // 链里任何没料到的错都收成一次正常失败答复，别把插件方法抛穿到 bridge。
            Log.w(TAG, "resolve failed unexpectedly", error);
            call.resolve(failure("network", "The stream resolve failed unexpectedly", new ArrayList<>()));
        } finally {
            resolveLock.unlock();
        }
    }

    /** 登录会话（只在这一次调用里活着，用完即弃）。 */
    private static final class Session {
        final String cookie;
        final String userAgent;

        Session(String cookie, String userAgent) {
            this.cookie = cookie;
            this.userAgent = userAgent;
        }
    }

    /** 一次客户端尝试的结果：要么是选中的格式，要么是一个分类好的失败。 */
    private static final class Attempt {
        final String clientKey;
        // 成功时才有的字段
        JSONObject format;
        String level;
        // 失败分类：login / unplayable / region / rate / formats / egress / network / invalid
        String failureKind;
        String detail;

        Attempt(String clientKey) {
            this.clientKey = clientKey;
        }

        static Attempt failed(String clientKey, String kind, String detail) {
            Attempt attempt = new Attempt(clientKey);
            attempt.failureKind = kind;
            attempt.detail = detail;
            return attempt;
        }
    }

    private JSObject resolve(String videoId, String quality, Session session, boolean allowSignedIn) {
        List<JSObject> attempts = new ArrayList<>();
        long startedAt = System.currentTimeMillis();
        boolean canSignIn = session != null && allowSignedIn;

        // ultra 专线（设计稿 §2.1）：要会员格式就直接带会话跑；灭了再回落匿名链以 high 兜底。
        if (canSignIn && "ultra".equals(quality)) {
            JSObject signedInAnswer = runChain(videoId, quality, session, attempts, startedAt);
            if (signedInAnswer != null) return signedInAnswer;
            // 登录链里的硬失败（不可播 / 地区 / 429）在 runChain 里已经直接成答，这里只剩软失败。
            if (terminalAnswer != null) return terminalAnswer;
        }

        JSObject anonymousAnswer = runChain(videoId, quality, null, attempts, startedAt);
        if (anonymousAnswer != null) return anonymousAnswer;
        if (terminalAnswer != null) return terminalAnswer;

        // 匿名链软失败收尾：撞上的是登录门、且手里正好有会话，就带会话把同一条链重跑一遍。
        if (canSignIn && sawLoginGate) {
            JSObject signedInAnswer = runChain(videoId, quality, session, attempts, startedAt);
            if (signedInAnswer != null) return signedInAnswer;
            if (terminalAnswer != null) return terminalAnswer;
        }

        return failureFromAttempts(attempts);
    }

    /** 全链软失败的最终成答：分类优先级 登录门 > 格式类 > 出口 > 响应形状 > 网络。 */
    private JSObject failureFromAttempts(List<JSObject> attempts) {
        boolean sawFormats = false;
        boolean sawEgress = false;
        boolean sawInvalid = false;
        boolean sawLogin = false;
        StringBuilder summary = new StringBuilder();
        for (JSObject line : attempts) {
            String kind = line.optString("code");
            if ("login".equals(kind)) sawLogin = true;
            if ("formats".equals(kind)) sawFormats = true;
            if ("egress".equals(kind)) sawEgress = true;
            if ("invalid".equals(kind)) sawInvalid = true;
            if (summary.length() > 0) summary.append("; ");
            summary.append(line.optString("client")).append(": ").append(kind);
            String detail = line.optString("detail");
            if (!detail.isEmpty()) summary.append(" (").append(detail).append(")");
        }
        if (sawLogin) {
            return failure("login-required",
                "YouTube Music asked for a sign-in on every client tried: " + summary, attempts);
        }
        if (sawFormats) {
            return failure("not-playable",
                "No client handed over a playable format: " + summary, attempts);
        }
        if (sawEgress) {
            return failure("egress-blocked",
                "The stream address could not be fetched from this device: " + summary, attempts);
        }
        if (sawInvalid) {
            return failure("invalid-response",
                "YouTube Music answered in a shape the bridge does not read: " + summary, attempts);
        }
        return failure("network", "The stream could not be fetched: " + summary, attempts);
    }

    // runChain 的两个旁路出口（单线程串行下用字段传，比再套一层结果类易读）：
    // terminalAnswer 非空 = 链被硬失败中止（429 / 不可播 / 地区），整次 resolve 直接成答；
    // sawLoginGate = 这一轮里有客户端答了登录门。
    private JSObject terminalAnswer;
    private boolean sawLoginGate;

    /**
     * 跑一遍回退链。返回非空 = 成功答复（已含 egress 自检通过）；返回 null 时看
     * {@link #terminalAnswer}（硬失败成答）与 {@link #sawLoginGate}。软失败只记 attempts。
     */
    private JSObject runChain(String videoId, String quality, Session session, List<JSObject> attempts, long startedAt) {
        terminalAnswer = null;
        sawLoginGate = false;
        boolean signedInRun = session != null;
        String visitorData = signedInRun ? fetchVisitorData(session) : ensureAnonymousVisitorData();
        for (ClientSpec client : CHAIN) {
            if (System.currentTimeMillis() - startedAt > CHAIN_BUDGET_MS) {
                attempts.add(attemptLine(client, "network", "chain budget spent"));
                break;
            }
            Attempt attempt = tryClient(client, videoId, quality, session, visitorData);
            if (attempt.format != null) {
                JSObject stream = streamOf(client, attempt, signedInRun);
                if (stream != null) {
                    JSObject result = new JSObject();
                    result.put("ok", true);
                    result.put("stream", stream);
                    return result;
                }
                // streamOf 里 egress 自检没过：这一级作废，自检结论已记进 attempt，转下一级。
                attempts.add(attemptLine(client, "egress", attempt.detail));
                continue;
            }
            attempts.add(attemptLine(client, attempt.failureKind, attempt.detail));
            switch (attempt.failureKind) {
                case "rate":
                    terminalAnswer = failure("rate-limited",
                        "YouTube answered 429 during the " + client.key + " attempt", attempts);
                    return null;
                case "region":
                    terminalAnswer = failure("region-restricted",
                        "This track is not available in this region (" + attempt.detail + ")", attempts);
                    return null;
                case "unplayable":
                    terminalAnswer = failure("not-playable",
                        "YouTube Music cannot play this track (" + attempt.detail + ")", attempts);
                    return null;
                case "login":
                    sawLoginGate = true;
                    break;
                default:
                    break;
            }
        }
        return null;
    }

    /** 用一个客户端问一次 player 接口。答复分类按设计稿 §6.1 的表。 */
    private Attempt tryClient(ClientSpec client, String videoId, String quality, Session session, String visitorData) {
        JSONObject contextClient = new JSONObject();
        try {
            contextClient.put("clientName", client.clientName);
            contextClient.put("clientVersion", client.clientVersion);
            if (client.deviceMake != null) contextClient.put("deviceMake", client.deviceMake);
            if (client.deviceModel != null) contextClient.put("deviceModel", client.deviceModel);
            if (client.osName != null) contextClient.put("osName", client.osName);
            if (client.osVersion != null) contextClient.put("osVersion", client.osVersion);
            if (client.androidSdkVersion > 0) contextClient.put("androidSdkVersion", client.androidSdkVersion);
            contextClient.put("hl", "en");
            contextClient.put("gl", "US");
            if (visitorData != null && !visitorData.isEmpty()) contextClient.put("visitorData", visitorData);
            JSONObject context = new JSONObject();
            context.put("client", contextClient);
            context.put("user", new JSONObject().put("lockedSafetyMode", false));
            context.put("request", new JSONObject().put("useSsl", true));
            if (client == TV_EMBEDDED) {
                // embedded 客户端要带上它嵌在哪个页面里，不然不算一个 embed 上下文。
                context.put("thirdParty", new JSONObject().put("embedUrl", "https://www.youtube.com/"));
            }
            JSONObject body = new JSONObject();
            body.put("context", context);
            body.put("videoId", videoId);
            JSONObject playback = new JSONObject();
            playback.put("contentPlaybackContext", new JSONObject()
                .put("vis", 0).put("splay", false).put("lactMilliseconds", "-1"));
            body.put("playbackContext", playback);
            body.put("racyCheckOk", true);
            body.put("contentCheckOk", true);

            Request.Builder request = new Request.Builder()
                .url(PLAYER_URL + "&key=" + client.apiKey)
                .post(RequestBody.create(body.toString(), JSON_TYPE))
                .header("User-Agent", client.userAgent)
                .header("X-YouTube-Client-Name", String.valueOf(client.clientNameId))
                .header("X-YouTube-Client-Version", client.clientVersion)
                .header("Content-Type", "application/json");
            if (session != null) {
                request.header("Cookie", session.cookie);
                String authorization = sapisidHash(session.cookie);
                if (authorization != null) request.header("Authorization", authorization);
                request.header("X-Goog-AuthUser", "0");
            }

            try (Response response = http.newCall(request.build()).execute()) {
                if (response.code() == 429) return Attempt.failed(client.key, "rate", "HTTP 429");
                ResponseBody responseBody = response.body();
                if (!response.isSuccessful() || responseBody == null) {
                    return Attempt.failed(client.key, "network", "HTTP " + response.code());
                }
                JSONObject data = new JSONObject(responseBody.string());
                // 答复里带回的 visitorData 比本地新：匿名那份顺手换上（登录那份与 cookie 同源，不跨调用留）。
                String freshVisitor = data.optJSONObject("responseContext") != null
                    ? data.optJSONObject("responseContext").optString("visitorData", "") : "";
                if (session == null && !freshVisitor.isEmpty() && !freshVisitor.equals(anonymousVisitorData)) {
                    anonymousVisitorData = freshVisitor;
                }
                return readPlayerAnswer(client, data, quality);
            }
        } catch (IOException error) {
            return Attempt.failed(client.key, "network", error.getClass().getSimpleName());
        } catch (RuntimeException error) {
            // 含 org.json 的解析错：答复形状不是桥读得懂的那种。
            return Attempt.failed(client.key, "invalid", error.getClass().getSimpleName());
        }
    }

    /** player 答复 → 选中格式或分类失败（设计稿 §3.2 / §6.1）。 */
    private Attempt readPlayerAnswer(ClientSpec client, JSONObject data, String quality) {
        JSONObject playability = data.optJSONObject("playabilityStatus");
        String status = playability != null ? playability.optString("status", "") : "";
        String reason = playability != null ? playability.optString("reason", "") : "";
        if (status.isEmpty()) return Attempt.failed(client.key, "invalid", "no playability status");
        // 登录门与年龄门同类（设计稿 §4.4）：都是「带上会话再问一次」能解的门，记 login 触发登录支线。
        if ("LOGIN_REQUIRED".equals(status) || "AGE_CHECK_REQUIRED".equals(status)) {
            return Attempt.failed(client.key, "login", firstWord(reason, status));
        }
        if (reason.toLowerCase(java.util.Locale.ROOT).contains("country")) {
            return Attempt.failed(client.key, "region", firstWord(reason, status));
        }
        if (!"OK".equals(status)) return Attempt.failed(client.key, "unplayable", firstWord(reason, status));

        JSONObject streaming = data.optJSONObject("streamingData");
        if (streaming == null) return Attempt.failed(client.key, "formats", "no streaming data");
        JSONArray formats = streaming.optJSONArray("adaptiveFormats");
        if (formats == null || formats.length() == 0) {
            return Attempt.failed(client.key, "formats",
                streaming.has("serverAbrStreamingUrl") ? "sabr-only" : "formats: none");
        }
        Picked picked = pickAudioFormat(formats, quality);
        if (picked == null) return Attempt.failed(client.key, "formats", "formats: none at this level");
        String url = picked.format.optString("url", "");
        if (url.isEmpty()) {
            return Attempt.failed(client.key, "formats",
                picked.format.has("signatureCipher") ? "cipher-only" : "formats: no plain url");
        }
        Attempt attempt = new Attempt(client.key);
        attempt.format = picked.format;
        attempt.level = picked.level;
        return attempt;
    }

    /** 选中格式 → 先做出口自检，再组成功答复。自检不过返回 null 并把结论写进 attempt.detail。 */
    private JSObject streamOf(ClientSpec client, Attempt attempt, boolean signedInRun) {
        JSONObject format = attempt.format;
        String url = format.optString("url", "");
        String egressProblem = checkEgress(url);
        if (egressProblem != null) {
            attempt.detail = egressProblem;
            return null;
        }
        JSObject stream = new JSObject();
        stream.put("url", url);
        stream.put("itag", format.optInt("itag", 0));
        stream.put("bitrate", bitrateOf(format));
        stream.put("mimeType", format.optString("mimeType", ""));
        stream.put("contentLength", parseLong(format.optString("contentLength", ""), format.optLong("contentLength", 0)));
        stream.put("level", attempt.level);
        stream.put("route", signedInRun ? client.route + "+signed-in" : client.route);
        stream.put("clientUsed", client.key);
        stream.put("expiresAt", expiresAtOf(url));
        Log.i(TAG, "stream by " + client.key + (signedInRun ? " (signed in)" : "")
            + ": itag " + format.optInt("itag", 0) + ", level " + attempt.level);
        return stream;
    }

    /**
     * 出口自检（设计稿 T1 探针的桥内形态）：选中直链后先替播放器问一个字节。
     * 取链的请求与取流的请求若出口 IP 不一致，googlevideo 按链上绑的 IP 回 403——
     * 这一步在原生栈里先撞一遍，撞死了就换下一级客户端，而不是把死链交给播放器。
     * 返回 null = 通过；否则是失败结论（进 attempts 与 status 的 egress 行）。
     */
    private String checkEgress(String url) {
        Request request = new Request.Builder().url(url).header("Range", "bytes=0-0").build();
        try (Response response = http.newCall(request).execute()) {
            String type = response.header("Content-Type", "");
            if ((response.code() == 200 || response.code() == 206) && !type.startsWith("text/")) {
                lastEgress = "ok";
                return null;
            }
            lastEgress = "failed (HTTP " + response.code() + ")";
            return "egress: HTTP " + response.code();
        } catch (IOException | RuntimeException error) {
            lastEgress = "failed (" + error.getClass().getSimpleName() + ")";
            return "egress: " + error.getClass().getSimpleName();
        }
    }

    private static final class Picked {
        final JSONObject format;
        final String level;

        Picked(JSONObject format, String level) {
            this.format = format;
            this.level = level;
        }
    }

    /**
     * 与桌面 pickAudioFormat（electron/ytm/ytmApiBridge.cjs）同一套规则，逐条对应：
     * 先滤原音轨，standard 认 itag 250 / 最接近 64k 的 Opus，high 取最高码率，
     * ultra 只认标了 AUDIO_QUALITY_HIGH 的 774/141、无则报该档无格式（由上层降级）。
     * 一处已知差异：桌面经 youtubei.js 解析，配音标记（is_dubbed 等）来自直链里
     * xtags 的 protobuf 解码；原始答复这层没有现成字段，本版以原始字段等价替代——
     * isDrc 布尔 + audioTrack.audioIsDefault（非默认音轨正是「原音轨」过滤的主干），
     * 且过滤后为空时与桌面一样回退到全部音频格式，不会因此选空。
     */
    private Picked pickAudioFormat(JSONArray formats, String level) {
        List<JSONObject> audio = new ArrayList<>();
        for (int i = 0; i < formats.length(); i++) {
            JSONObject format = formats.optJSONObject(i);
            if (format == null) continue;
            if (!format.optString("mimeType", "").startsWith("audio/")) continue;
            if (parseLong(format.optString("contentLength", ""), format.optLong("contentLength", 0)) <= 0) continue;
            audio.add(format);
        }
        if (audio.isEmpty()) return null;
        List<JSONObject> original = new ArrayList<>();
        for (JSONObject format : audio) {
            if (format.optBoolean("isDrc", false)) continue;
            JSONObject track = format.optJSONObject("audioTrack");
            if (track != null && track.has("audioIsDefault") && !track.optBoolean("audioIsDefault", true)) continue;
            original.add(format);
        }
        List<JSONObject> every = original.isEmpty() ? audio : original;

        if ("ultra".equals(level)) {
            for (int itag : ULTRA_ITAGS) {
                for (JSONObject format : every) {
                    if (format.optInt("itag", -1) == itag
                        && "AUDIO_QUALITY_HIGH".equals(format.optString("audioQuality", ""))) {
                        return new Picked(format, "ultra");
                    }
                }
            }
            // ultra 这一档没有：按桌面 served 语义降到 high 规则，level 如实报 high。
            return pickNonUltra(every, "high");
        }
        return pickNonUltra(every, level);
    }

    private Picked pickNonUltra(List<JSONObject> every, String level) {
        List<JSONObject> guests = new ArrayList<>();
        for (JSONObject format : every) {
            int itag = format.optInt("itag", -1);
            if (itag != ULTRA_ITAGS[0] && itag != ULTRA_ITAGS[1]) guests.add(format);
        }
        List<JSONObject> offered = guests.isEmpty() ? every : guests;
        if ("standard".equals(level)) {
            List<JSONObject> audible = new ArrayList<>();
            for (JSONObject format : offered) {
                if (bitrateOf(format) >= STANDARD_FLOOR_BITRATE) audible.add(format);
            }
            List<JSONObject> opus = new ArrayList<>();
            for (JSONObject format : audible) {
                if (format.optString("mimeType", "").toLowerCase(java.util.Locale.ROOT).contains("opus")) opus.add(format);
            }
            List<JSONObject> among = opus.isEmpty() ? audible : opus;
            JSONObject best = null;
            for (JSONObject format : among) {
                if (format.optInt("itag", -1) == STANDARD_ITAG) { best = format; break; }
            }
            if (best == null) {
                long bestDistance = Long.MAX_VALUE;
                for (JSONObject format : among) {
                    long distance = Math.abs(bitrateOf(format) - STANDARD_BITRATE);
                    if (distance < bestDistance) { bestDistance = distance; best = format; }
                }
            }
            if (best != null) return new Picked(best, "standard");
        }
        JSONObject highest = null;
        for (JSONObject format : offered) {
            if (highest == null || format.optLong("bitrate", 0) > highest.optLong("bitrate", 0)) highest = format;
        }
        return highest != null ? new Picked(highest, "high".equals(level) ? "high" : level) : null;
    }

    private static long bitrateOf(JSONObject format) {
        long average = format.optLong("averageBitrate", 0);
        return average > 0 ? average : format.optLong("bitrate", 0);
    }

    private static long parseLong(String text, long fallback) {
        try {
            return text == null || text.isEmpty() ? fallback : Long.parseLong(text.trim());
        } catch (NumberFormatException error) {
            return fallback;
        }
    }

    /** 直链里的 expire 参数（Unix 秒）→ 毫秒；读不到以取链时刻 + 6 小时兜底（设计稿 §4.2）。 */
    private static long expiresAtOf(String url) {
        int marker = url.indexOf("expire=");
        if (marker >= 0) {
            int from = marker + "expire=".length();
            int to = from;
            while (to < url.length() && Character.isDigit(url.charAt(to))) to++;
            long seconds = parseLong(url.substring(from, to), 0);
            if (seconds > 0) return seconds * 1000L;
        }
        return System.currentTimeMillis() + 6L * 60L * 60L * 1000L;
    }

    /** 匿名 visitorData：缓存优先，没有就现取一份（失败不拦路，请求少带它照样发）。 */
    private String ensureAnonymousVisitorData() {
        String held = anonymousVisitorData;
        if (held != null && !held.isEmpty()) return held;
        String fresh = fetchVisitorData(null);
        if (fresh != null) anonymousVisitorData = fresh;
        return fresh;
    }

    /**
     * 向 visitor_id 端点换一份 visitorData。登录时必须与 cookie 同源现换（设计稿 §3.3），
     * 所以带会话来时不读缓存、也不写缓存。取不到返回 null——它是成功率问题不是凭据，
     * 缺了照样发 player 请求，只是更容易被挡。
     */
    private String fetchVisitorData(Session session) {
        try {
            JSONObject client = new JSONObject()
                .put("clientName", "WEB").put("clientVersion", WEB_CLIENT_VERSION)
                .put("hl", "en").put("gl", "US");
            JSONObject body = new JSONObject().put("context", new JSONObject().put("client", client));
            Request.Builder request = new Request.Builder()
                .url(VISITOR_URL + "&key=" + WEB_API_KEY)
                .post(RequestBody.create(body.toString(), JSON_TYPE))
                .header("Content-Type", "application/json");
            if (session != null) {
                request.header("Cookie", session.cookie);
                request.header("User-Agent", session.userAgent);
                String authorization = sapisidHash(session.cookie);
                if (authorization != null) request.header("Authorization", authorization);
                request.header("X-Goog-AuthUser", "0");
            }
            try (Response response = http.newCall(request.build()).execute()) {
                ResponseBody responseBody = response.body();
                if (!response.isSuccessful() || responseBody == null) return null;
                JSONObject data = new JSONObject(responseBody.string());
                JSONObject context = data.optJSONObject("responseContext");
                String visitor = context != null ? context.optString("visitorData", "") : "";
                return visitor.isEmpty() ? null : visitor;
            }
        } catch (IOException | RuntimeException error) {
            Log.w(TAG, "visitor data could not be fetched", error);
            return null;
        }
    }

    /**
     * SAPISIDHASH（网页系会话给接口请求带的那份签名），在桥内现算、cookie 不出这一次调用：
     * `SAPISIDHASH <unix秒>_<sha1("<unix秒> <SAPISID> https://www.youtube.com")>`。
     * cookie 里没有 SAPISID（或它的 __Secure- 形态）就返回 null，请求只带 Cookie。
     */
    private static String sapisidHash(String cookie) {
        String sapisid = null;
        for (String pair : cookie.split(";")) {
            int split = pair.indexOf('=');
            if (split <= 0) continue;
            String name = pair.substring(0, split).trim();
            if ("SAPISID".equals(name) || "__Secure-3PAPISID".equals(name)) {
                sapisid = pair.substring(split + 1).trim();
                break;
            }
        }
        if (sapisid == null || sapisid.isEmpty()) return null;
        long seconds = System.currentTimeMillis() / 1000L;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            byte[] hashed = digest.digest((seconds + " " + sapisid + " https://www.youtube.com")
                .getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : hashed) hex.append(String.format("%02x", b));
            return "SAPISIDHASH " + seconds + "_" + hex;
        } catch (java.security.NoSuchAlgorithmException error) {
            return null;
        }
    }

    /** reason 文本里的大写状态单词（诊断与 message 用）；没有就回落给定的缺省值。 */
    private static String firstWord(String reason, String fallback) {
        if (reason != null) {
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("[A-Z][A-Z_]{2,40}").matcher(reason);
            if (matcher.find()) return matcher.group();
        }
        return fallback;
    }

    private JSObject attemptLine(ClientSpec client, String kind, String detail) {
        JSObject line = new JSObject();
        line.put("client", client.key);
        line.put("code", kind);
        line.put("detail", detail == null ? "" : detail);
        return line;
    }

    private JSObject failure(String code, String message, List<JSObject> attempts) {
        JSObject error = new JSObject();
        error.put("code", code);
        error.put("message", message);
        JSArray lines = new JSArray();
        for (JSObject line : attempts) lines.put(line);
        error.put("attempts", lines);
        JSObject result = new JSObject();
        result.put("ok", false);
        result.put("error", error);
        return result;
    }
}
