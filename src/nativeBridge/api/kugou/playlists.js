import CryptoJS from '../../vendor/crypto-es.mjs';
import { noteLibraryStep } from '../libraryTrace.js';
import {
    KG_ANDROID_APPID,
    KG_ANDROID_CLIENTVER,
    KG_ANDROID_SIGN_SALT,
    KG_CLOUDLIST_GATEWAY,
    KG_CLOUDLIST_ROUTER,
    kgCookieToken,
    kgCookieUserId,
    kgPostAndroidSigned,
} from '../kugou.js';

// src/nativeBridge/api/kugou/playlists.js
//
// 歌单的写入：收藏 / 取消收藏歌单（也用来收藏专辑）、往歌单加歌、从歌单删歌。
// 上游是 KuGouMusicApi 的 /playlist/add、/playlist/del、/playlist/tracks/add、
// /playlist/tracks/del，url 与请求体照抄上游 module 下那四个文件。
//
// 与读取不同，这几条都要登录：没有 userid / token 就回「未登录」，让界面去登录，而不是
// 报一个看不懂的上游错误。

/** 网关地址；上游的默认 baseURL，cloudlist 的路由另外拼。 */
const KG_GATEWAY = 'https://gateway.kugou.com';

/** 未登录时的回答：读取那几条的写法，前端据此去登录。 */
const kgLoggedOut = (where) => ({
    status: 0,
    error_code: 401,
    data: {},
    message: `KuGou ${where}: login required`,
});

const credentialsOf = (cookieHeader, params) => {
    const userId = String(kgCookieUserId(cookieHeader) || params.userid || '').trim();
    const token = String(kgCookieToken(cookieHeader) || params.token || '').trim();
    return userId && token ? { userId, token } : null;
};

// ---- 收藏歌单 / 收藏专辑 ----

/**
 * 收藏歌单是 type 1，收藏专辑是 source 2，建自己的歌单是 type 0。
 * 上游在 type 为 0 时还多带一组 query（last_time / last_area / userid / token）。
 */
export async function handlePlaylistAdd(params, cookieHeader) {
    const credentials = credentialsOf(cookieHeader, params);
    if (!credentials) return kgLoggedOut('playlist-add');
    const { userId, token } = credentials;
    const type = Number(params.type) || 0;
    const source = params.source === 0 ? 0 : (Number(params.source) || 1);
    const clienttime = Math.floor(Date.now() / 1000);
    const body = {
        userid: Number(userId) || userId,
        token,
        total_ver: 0,
        name: String(params.name || ''),
        type,
        source,
        is_pri: type === 0 ? (Number(params.is_pri) || 0) : 0,
        list_create_userid: String(params.list_create_userid || ''),
        list_create_listid: String(params.list_create_listid || ''),
        list_create_gid: String(params.list_create_gid || ''),
        from_shupinmv: 0,
    };
    const answer = await kgPostAndroidSigned(
        KG_CLOUDLIST_GATEWAY,
        '/v5/add_list',
        cookieHeader,
        body,
        type === 0 ? { last_time: clienttime, last_area: 'gztx', userid: userId, token } : {},
    );
    noteLibraryStep('kugou', 'playlist:add', {
        type,
        source,
        status: answer && answer.status,
        errorCode: answer && answer.error_code,
    });
    return answer || kgLoggedOut('playlist-add');
}

// ---- 往歌单加歌 ----

/** `data` 是 `名称|hash|专辑id|mixsongid`，多首用逗号分隔；最少要有名称和 hash。 */
const trackResources = (raw) => String(raw || '').split(',').filter(Boolean).map((entry) => {
    const parts = String(entry).split('|');
    return {
        number: 1,
        name: parts[0] || '',
        hash: parts[1] || '',
        size: 0,
        sort: 0,
        timelen: 0,
        bitrate: 0,
        album_id: Number(parts[2] || 0),
        mixsongid: Number(parts[3] || 0),
    };
});

export async function handlePlaylistTracksAdd(params, cookieHeader) {
    const credentials = credentialsOf(cookieHeader, params);
    if (!credentials) return kgLoggedOut('playlist-tracks-add');
    const { userId, token } = credentials;
    const clienttime = Math.floor(Date.now() / 1000);
    const answer = await kgPostAndroidSigned(
        KG_CLOUDLIST_GATEWAY,
        '/v6/add_song',
        cookieHeader,
        {
            userid: Number(userId) || userId,
            token,
            listid: String(params.listid || ''),
            list_ver: 0,
            type: 0,
            slow_upload: 1,
            scene: 'false;null',
            data: trackResources(params.data),
        },
        { last_time: clienttime, last_area: 'gztx', userid: userId, token },
    );
    noteLibraryStep('kugou', 'playlist:tracks-add', {
        count: trackResources(params.data).length,
        status: answer && answer.status,
        errorCode: answer && answer.error_code,
    });
    return answer || kgLoggedOut('playlist-tracks-add');
}

// ---- 从歌单删歌 ----

export async function handlePlaylistTracksDel(params, cookieHeader) {
    const credentials = credentialsOf(cookieHeader, params);
    if (!credentials) return kgLoggedOut('playlist-tracks-del');
    const { userId, token } = credentials;
    const fileIds = String(params.fileids || '').split(',').filter(Boolean).map((id) => ({ fileid: Number(id) }));
    if (!fileIds.length) return { status: 1, error_code: 0, data: {} };
    const answer = await kgPostAndroidSigned(
        KG_GATEWAY,
        '/v4/delete_songs',
        cookieHeader,
        {
            listid: String(params.listid || ''),
            userid: Number(userId) || userId,
            data: fileIds,
            type: 0,
            token,
            list_ver: 0,
        },
        {},
        KG_CLOUDLIST_ROUTER,
    );
    noteLibraryStep('kugou', 'playlist:tracks-del', {
        count: fileIds.length,
        status: answer && answer.status,
        errorCode: answer && answer.error_code,
    });
    return answer || kgLoggedOut('playlist-tracks-del');
}

// ---- 取消收藏歌单 / 收藏专辑 ----
//
// 上游这一条要先把请求体 AES 加密，再用 RSA 公钥加密那把钥匙（p 参数）；
// 回包同样是密文。上游在 Node 侧用 node-forge，WebView 里没有它 ——
// crypto.subtle 又只在安全上下文里存在（自建 NAS 那个坑见 src/utils/sha256.ts），
// 所以 RSA 这里直接用 BigInt 做模幂：1024 位的公钥，一次加密几十毫秒。

/** 概念版（lite）的公钥，1024 位；指数固定 65537。 */
const RSA_MODULUS = BigInt('0xc40a2d0da76511f3bb1cc2bbd3afbd8bea83b4d6b05b6c13eb8920c53f1af7679b32ba0d0edb843240ef1b836efed3ee240734c14c1399fd6594d16af22f52525d14d72e0155c6dcc8638d4f7bb94f3a0b1f4c29f991972f2a160a25eb0a9e724336be7f69bbd319ffab1c6dd8470b021dc434f3faba89f4a2a01b33bdbdd08b');
const RSA_EXPONENT = 65537n;
/** 1024 位公钥的字节长度。 */
const RSA_SIZE = 128;

const modPow = (base, exponent, modulus) => {
    let result = 1n;
    let value = base % modulus;
    let power = exponent;
    while (power > 0n) {
        if (power % 2n === 1n) result = (result * value) % modulus;
        value = (value * value) % modulus;
        power /= 2n;
    }
    return result;
};

/** PKCS#1 v1.5 的加密块：0x00 0x02 || 非零随机填充 || 0x00 || 明文。 */
const pkcs1Pad = (bytes) => {
    const block = new Uint8Array(RSA_SIZE);
    block[0] = 0x00;
    block[1] = 0x02;
    const filler = new Uint8Array(RSA_SIZE - 3 - bytes.length);
    crypto.getRandomValues(filler);
    for (let index = 0; index < filler.length; index += 1) {
        block[2 + index] = filler[index] || 1;
    }
    block[RSA_SIZE - bytes.length - 1] = 0x00;
    block.set(bytes, RSA_SIZE - bytes.length);
    return block;
};

const rsaEncryptPkcs1 = (text) => {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > RSA_SIZE - 11) throw new Error('too long');
    let value = 0n;
    for (const byte of pkcs1Pad(bytes)) value = (value << 8n) | BigInt(byte);
    return modPow(value, RSA_EXPONENT, RSA_MODULUS).toString(16).padStart(RSA_SIZE * 2, '0').toUpperCase();
};

/** 上游的 key 从同一个 36 字符的字表里随机取 6 位。 */
const KEY_CHARS = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const randomKey = () => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => KEY_CHARS[byte % KEY_CHARS.length]).join('').toLowerCase();
};

/** 钥匙 md5 的前 16 位是 AES 的 key，后 16 位是 iv。 */
const aesParts = (key) => {
    const digest = CryptoJS.MD5(key).toString();
    return { cipherKey: digest.substring(0, 16), iv: digest.substring(16, 32) };
};

const aesEncrypt = (data) => {
    const key = randomKey();
    const { cipherKey, iv } = aesParts(key);
    const encrypted = CryptoJS.AES.encrypt(
        CryptoJS.enc.Utf8.parse(typeof data === 'object' ? JSON.stringify(data) : String(data)),
        CryptoJS.enc.Utf8.parse(cipherKey),
        { iv: CryptoJS.enc.Utf8.parse(iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    );
    return { key, str: CryptoJS.enc.Base64.stringify(encrypted.ciphertext) };
};

const aesDecrypt = (key, str) => {
    const { cipherKey, iv } = aesParts(key);
    const decrypted = CryptoJS.AES.decrypt(
        CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(str) }),
        CryptoJS.enc.Utf8.parse(cipherKey),
        { iv: CryptoJS.enc.Utf8.parse(iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    );
    const text = decrypted.toString(CryptoJS.enc.Utf8);
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
};

/** 上游的 signParamsKey：md5(appid + 盐 + clientver + data)。 */
const signParamsKey = (data) => CryptoJS.MD5(
    `${KG_ANDROID_APPID}${KG_ANDROID_SIGN_SALT}${KG_ANDROID_CLIENTVER}${data}`,
).toString();

/**
 * 取消收藏歌单 / 取消收藏专辑。
 *
 * 回包是密文，本地桥这一侧只能拿到文本；解不开就按「已经删了」回成功 ——
 * 换成报错的话，界面会显示取消失败而服务端其实已经取消，那才是真的错。
 * 解不开会在诊断里留下 playlist:del:unverified，看日志能认出来。
 */
export async function handlePlaylistDel(params, cookieHeader) {
    const credentials = credentialsOf(cookieHeader, params);
    if (!credentials) return kgLoggedOut('playlist-del');
    const { userId, token } = credentials;
    const listId = Number(params.listid);
    if (!Number.isSafeInteger(listId) || listId <= 0) {
        return { status: 0, error_code: 400, data: {}, message: 'KuGou playlist-del: bad listid' };
    }
    const clienttime = Math.floor(Date.now() / 1000);
    const aes = aesEncrypt({ listid: listId, total_ver: 0, type: 1 });
    let p;
    try {
        p = rsaEncryptPkcs1(JSON.stringify({ aes: aes.key, uid: Number(userId) || userId, token }));
    } catch (error) {
        noteLibraryStep('kugou', 'playlist:del:rsa-failed', { message: String(error && error.message) });
        return kgLoggedOut('playlist-del');
    }
    const raw = await kgPostAndroidSigned(
        KG_GATEWAY,
        '/v2/delete_list',
        cookieHeader,
        aes.str,
        {
            clienttime,
            key: signParamsKey(String(clienttime)),
            last_area: 'gztx',
            clientver: KG_ANDROID_CLIENTVER,
            appid: KG_ANDROID_APPID,
            last_time: clienttime,
            p,
        },
        KG_CLOUDLIST_ROUTER,
        { rawBody: true, rawText: true },
    );
    const answer = typeof raw === 'string' && raw.trim() ? aesDecrypt(aes.key, raw.trim()) : null;
    if (!answer) {
        noteLibraryStep('kugou', 'playlist:del:unverified', { length: String(raw || '').length });
        return { status: 1, error_code: 0, data: {} };
    }
    noteLibraryStep('kugou', 'playlist:del', {
        status: answer.status,
        errorCode: answer.error_code,
    });
    return answer;
}
