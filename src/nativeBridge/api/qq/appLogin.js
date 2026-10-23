/**
 * QQ 音乐 App 扫码登录（「三合一」那张码）—— 手机上用 **QQ音乐 App / 手机QQ / 微信** 任一款扫同一张码。
 *
 * 与 `qq-login-qr.js`（手机QQ 的 ptlogin 网页码）、`qq-wechat-login.js`（微信 OAuth 码）并列，
 * 是第三条通道，也是上游 `qqmusic` 通道在安卓内置桥里的落地：
 *  0. POST musicu `music.getSession.session/GetSession` → 设备会话 uid / sid，之后每笔 comm 都带
 *  1. POST u.y.qq.com musicu `music.login.LoginServer/CreateQRCode` → qrcodeID + 二维码图
 *     （comm 照安卓客户端：ct 23 / cv 0，参数里 tmeAppID qqmusic、ct 11、cv 14090008）
 *  2. 连 `wss://mu.y.qq.com/ws/handshake`，订阅 `management.qrcode_login/<qrcodeID>`（见 `mqtt.js`）
 *  3. 收到 `cookies` 事件：载荷里是 `qqmusic_uin` 与换票令牌 `qqmusic_key`，**不是**最终凭证
 *  4. POST musicu `music.login.LoginServer/Login`（tmeLoginType 6，微信账号以回包的 loginType 为准）
 *     换出 musickey，再按二维码通道的口径拼出会话 cookie
 *
 * 🔴 换票令牌只在内存里活到这次登录结束：本模块不留任何落盘状态，二维码取消 / 过期 / 成功都关连接。
 * 🔴 `loginType` 不能一律写 6：QQ 音乐 App 里登的是微信账号时，回包会给 1，写成 6 会让之后每个请求
 * 都被上游按 QQ 账号解析而拒收（和 `qq-wechat-login.js` 里那段同源）。
 */

import { clearCookieCache, saveProviderCookie, setBrowserCookies } from '../cookies.js';
import { noteQrLoginStep, resetQrLoginTrace } from '../qrLoginTrace.js';
import { buildLoginSession, clearQQPlatformSessionCookies, fetchWithTimeout } from '../qq-login-qr.js';
import { openQrListener } from './mqtt.js';

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const CHANNEL = 'qqmusic';
/** 手机 QQ 的账号类型。App 通道照官方客户端也送 6，账号真正的类型以换票回包为准。 */
const MOBILE_LOGIN_TYPE = 6;
/** 二维码最长活 3 分钟（上游 `QR_TTL_MS`）：再长的 ttl 只会在后台多占一条连接。 */
const MAX_TTL_MS = 180_000;

/** 二维码会话：key 就是 qrcodeID，只在内存里活到取消 / 过期 / 成功。 */
const sessions = new Map();

const sessionKey = (qrcodeId) => `app:${qrcodeId}`;

const randomHex = (length) => {
  let out = '';
  const cryptoObject = typeof crypto !== 'undefined' ? crypto : null;
  if (cryptoObject?.getRandomValues) {
    const buffer = new Uint8Array(Math.ceil(length / 2));
    cryptoObject.getRandomValues(buffer);
    out = Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } else {
    for (let index = 0; index < length; index += 1) out += Math.floor(Math.random() * 16).toString(16);
  }
  return out.slice(0, length);
};

const randomDigits = (length) => {
  let out = '';
  for (let index = 0; index < length; index += 1) out += Math.floor(Math.random() * 10);
  return out;
};

// 设备身份只用来让上游把这次登录当成一台新设备，不涉及任何账号信息；每次启动换一套即可。
// 字段与上游 `createAndroidDevice()` 同一套：换票那一笔上游会拿 `rom` / `phonetype` / `os_ver`
// 去核对「取码的是不是这台设备」，写少了同样是没有解释的 `code 1000` 级别拒绝。
let deviceIdentity = null;
const device = () => {
  if (!deviceIdentity) {
    deviceIdentity = {
      openUdid: randomHex(32),
      androidId: randomHex(16),
      osRelease: '10',
      model: 'MI 6',
      sdk: 29,
      fingerprint: `xiaomi/iarim/sagit:10/eomam.200122.001/${randomDigits(7)}:user/release-keys`,
      sessionUid: '',
      sessionSid: '',
    };
  }
  return deviceIdentity;
};

/**
 * musicu 的 comm，照安卓客户端那一套（上游 `buildAndroidComm`）。
 *
 * 🔴 `ct/cv` 是「我是谁」：**取码那一笔**上游传 `{ ct: 23, cv: 0 }`（网页那张脸），
 * **换票这一笔**必须回到安卓客户端的 `{ ct: 11, cv: 14090008 }` —— 差在这一对上，上游就是
 * 一句不带任何解释的 `code 1000`（凭据不被接受），看不出是脸不对还是令牌不对。
 */
const buildComm = (overrides = {}) => {
  const identity = device();
  return {
    ct: 11,
    cv: 14090008,
    v: 14090008,
    chid: '10003505',
    tmeAppID: 'qqmusic',
    // QIMEI 是空串也照样走通（取码那笔就是这么验的），上游只要求字段在。
    QIMEI: '',
    QIMEI36: '',
    OpenUDID: identity.openUdid,
    udid: identity.openUdid,
    OpenUDID2: identity.openUdid,
    aid: identity.androidId,
    os_ver: identity.osRelease,
    phonetype: identity.model,
    devicelevel: String(identity.sdk),
    newdevicelevel: String(identity.sdk),
    rom: identity.fingerprint,
    ...(identity.sessionUid ? { uid: identity.sessionUid } : {}),
    ...(identity.sessionSid ? { sid: identity.sessionSid } : {}),
    ...overrides,
  };
};

/**
 * 设备会话 bootstrap：上游在取码 **之前** 先 `GetSession` 拿 `uid` / `sid`，之后每一笔 comm 都带上
 * （`buildAndroidComm` 里那两个 `device.sessionUid/sessionSid` 分支）。不带这两个字段，换票那一笔
 * 上游照样回一句没有解释的 `code 1000` —— 而 `1000 / 104400 / 104401` 这一组在上游的错误码登记表里
 * 就是「凭据不被接受」，不是网络问题。
 *
 * 这一笔失败不拦登录：实测 `CreateQRCode` 没有它也能出码（QIMEI 同理，空串照走），
 * 所以这里只记一条诊断，剩下的交给二维码本身成败。
 */
const bootstrapDeviceSession = async () => {
  const identity = device();
  if (identity.sessionUid && identity.sessionSid) return identity;
  try {
    const body = JSON.stringify({
      comm: buildComm(),
      req_0: { module: 'music.getSession.session', method: 'GetSession', param: { uid: identity.sessionUid || '', vkey: 0, caller: 0 } },
    });
    const data = await postMusicu(body);
    const session = (data && data.session) || {};
    const uid = String(session.uid ?? '').trim();
    const sid = String(session.sid ?? '').trim();
    if (!uid || !sid) throw new Error('GetSession returned no uid/sid');
    identity.sessionUid = uid;
    identity.sessionSid = sid;
    noteQrLoginStep('app:qr:session:ok');
  } catch (error) {
    noteQrLoginStep('app:qr:session:failed', { message: error?.message || String(error) });
  }
  return identity;
};

const postMusicu = async (body, timeout = 15000) => {
  const response = await fetchWithTimeout(`${MUSICU_URL}?format=json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      // 上游 `callMusicu` 送的是客户端自己的 UA，不是浏览器的：换票那一笔认这个头。
      'User-Agent': `QQMusic 14090008(android ${device().osRelease})`,
    },
    body,
  }, timeout);
  const json = await response.json().catch(() => null);
  const item = json && (json.req_0 || json.req);
  const globalCode = Number(json?.code ?? 0);
  const upstreamCode = Number(item?.code ?? 0);
  if (!item || globalCode !== 0 || upstreamCode !== 0 || !item.data) {
    const error = new Error(`QQ app QR: musicu rejected (upstream ${item?.code ?? 'unknown'}, global ${json?.code ?? 'unknown'})`);
    error.upstreamCode = Number.isFinite(upstreamCode) ? upstreamCode : undefined;
    error.globalCode = Number.isFinite(globalCode) ? globalCode : undefined;
    throw error;
  }
  return item.data;
};

/** 要一张 App 扫码的码。图和 id 一起回来，图是 data URL，界面拿到就能画。 */
const createAppQr = async () => {
  const body = JSON.stringify({
    comm: buildComm({ ct: 23, cv: 0 }),
    req_0: {
      module: 'music.login.LoginServer',
      method: 'CreateQRCode',
      param: { tmeAppID: 'qqmusic', ct: 11, cv: 14090008 },
    },
  });
  const data = await postMusicu(body);
  const qrcodeId = String(data.qrcodeID || '');
  const image = String(data.qrcode || '');
  if (!qrcodeId || !image.startsWith('data:image/')) {
    throw new Error('QQ app QR: CreateQRCode returned no qrcodeID/image');
  }
  const expiresIn = Number(data.expiresIn);
  return {
    qrcodeId,
    qrimg: image,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 180,
  };
};

/**
 * 换票：MQTT 给的是令牌，拿它换 musickey。
 * 19 位的微信账号 id 超过安全整数，`Number()` 会变成另一个账号（上游 50006），所以数字原样写进正文。
 */
const exchangeCredential = async (qrcodeId, musicid, token) => {
  const musicIdLiteral = /^\d{1,19}$/.test(musicid) ? musicid : JSON.stringify(musicid);
  const body = `{"comm":${JSON.stringify(buildComm({ tmeLoginType: MOBILE_LOGIN_TYPE }))},"req_0":{"module":"music.login.LoginServer","method":"Login","param":{"musicid":${musicIdLiteral},"qrCodeID":${JSON.stringify(qrcodeId)},"token":${JSON.stringify(token)}}}}`;
  const data = await postMusicu(body);
  const musicKey = String(data.musickey || '');
  // 微信账号的 musicid 是占位的 0，真正的账号 ID 只在 str_musicid 里。
  const strMusicId = String(data.str_musicid ?? '').trim();
  const rawMusicId = String(data.musicid ?? '').trim();
  const accountId = (strMusicId && strMusicId !== '0' ? strMusicId : '')
    || (rawMusicId && rawMusicId !== '0' ? rawMusicId : '')
    || musicid;
  const loginType = Number(data.loginType) || MOBILE_LOGIN_TYPE;
  if (!musicKey) throw new Error('QQ app QR: exchange returned no musickey');
  return { accountId: accountId.replace(/\D/g, ''), musicKey, loginType };
};

/**
 * 拿一份凭据去读登录用户（`music.UserInfo.userInfoServer/GetLoginUserInfo`），能读通就说明
 * 上游认这份凭据。上游把这当成换票失败后的兜底验证（`getLoginUser`）。
 *
 * 🔴 comm 里带 `qq` / `authst` / `tmeLoginType` 就是「我是谁」：这三个字段就是上游
 * `buildAndroidComm(device, credential)` 在带凭据时多加的那一段。
 */
const validateCredential = async (credential) => {
  const body = JSON.stringify({
    comm: buildComm({
      qq: credential.accountId,
      authst: credential.musicKey,
      tmeLoginType: credential.loginType,
    }),
    req_0: { module: 'music.UserInfo.userInfoServer', method: 'GetLoginUserInfo', param: {} },
  });
  await postMusicu(body);
  return credential;
};

/**
 * 换票失败后的兜底：MQTT 给的那个令牌本身有时就是能用的 musickey（上游
 * `exchangeQqLogin` 里记着这条：`fallbackAttempted`）。用「拿它去读一次登录用户」来判定，
 * 读得通就认，读不通再抛换票那一步的原始错误 —— 别让兜底的失败盖掉真正的原因。
 */
const credentialFromToken = (musicid, token) => ({
  accountId: String(musicid).replace(/\D/g, ''),
  musicKey: String(token || ''),
  loginType: MOBILE_LOGIN_TYPE,
});

const resolveCredential = async (qrcodeId, musicid, token) => {
  try {
    return await exchangeCredential(qrcodeId, musicid, token);
  } catch (error) {
    noteQrLoginStep('app:qr:exchange:fallback:start', { message: error?.message || String(error) });
    const direct = credentialFromToken(musicid, token);
    if (!direct.musicKey) throw error;
    try {
      await validateCredential(direct);
      noteQrLoginStep('app:qr:exchange:fallback:ok');
      return direct;
    } catch (validationError) {
      noteQrLoginStep('app:qr:exchange:fallback:failed', { message: validationError?.message || String(validationError) });
      throw error;
    }
  }
};

const buildCookie = ({ accountId, musicKey, loginType }) => {
  const pairs = [
    `uin=o${accountId}`,
    `qqmusic_uin=o${accountId}`,
    `qm_keyst=${musicKey}`,
    `qqmusic_key=${musicKey}`,
    `tmeLoginType=${loginType}`,
    `str_musicid=${accountId}`,
  ];
  // 微信账号：cookies.js 在 login_type=2 时优先读 wxuin，与 uin 指向同一个真账号才不会分叉。
  if (Number(loginType) === 1) pairs.unshift('login_type=2', `wxuin=${accountId}`);
  return pairs.join('; ');
};

const applySession = async (cookie) => {
  const sessionData = buildLoginSession(cookie);
  // 上一条通道（ptlogin / 微信）留在同一个 cookie 罐里的凭据必须先清掉，否则会混进别人的 uin。
  await clearQQPlatformSessionCookies();
  await setBrowserCookies('https://y.qq.com/', sessionData.cookie);
  await setBrowserCookies('https://qq.com/', sessionData.cookie);
  clearCookieCache();
  await saveProviderCookie('qq', sessionData.cookie);
  return sessionData;
};

const expired = () => ({ isOk: false, code: 65, refresh: true, provider: 'qq', status: 'expired', message: '二维码已过期' });

const waiting = () => ({ isOk: false, code: 66, refresh: false, provider: 'qq', status: 'wait', message: '等待扫码' });

/**
 * 要码 + 立刻订阅。**订阅成立（SUBACK）之后才返回**：先给人看码、后订阅，
 * 中间那一下被扫的事件不会补送，用户会看到「手机提示登录成功、窗口一直转圈」。
 */
export async function qqAppGetLoginQr() {
  resetQrLoginTrace();
  prune();
  noteQrLoginStep('app:qr:create:start');
  await clearQQPlatformSessionCookies().catch(() => undefined);
  // 先取设备会话（uid/sid），再取码：之后每笔 comm 都靠它证明「取码和换票是同一台设备」。
  await bootstrapDeviceSession();
  const qr = await createAppQr();
  const session = {
    qrcodeId: qr.qrcodeId,
    qrimg: qr.qrimg,
    events: [],
    listener: null,
    result: null,
    exchanging: null,
    startedAt: Date.now(),
    expiresAt: Date.now() + Math.min(qr.expiresIn * 1000, MAX_TTL_MS),
  };
  sessions.set(sessionKey(qr.qrcodeId), session);
  try {
    session.listener = await openQrListener(
      qr.qrcodeId,
      (event) => session.events.push(event),
      Math.max(1000, session.expiresAt - Date.now()),
    );
  } catch (error) {
    sessions.delete(sessionKey(qr.qrcodeId));
    noteQrLoginStep('app:qr:create:listen-failed', { message: error?.message || String(error) });
    throw error;
  }
  noteQrLoginStep('app:qr:create:ok');
  return { qrsig: qr.qrcodeId, ptqrtoken: qr.qrcodeId, qrimg: qr.qrimg, channel: CHANNEL };
}

/** 关掉连接；条目留着 —— 界面拿到 803 / 终态之后可能还会再问一次，那时不能答「已过期」。 */
const release = (session) => {
  session.listener?.close();
  session.listener = null;
  session.finishedAt = session.finishedAt || Date.now();
};

const forget = (session) => {
  release(session);
  sessions.delete(sessionKey(session.qrcodeId));
};

/** 收掉早就结束的条目：每次要新码时的第一件事。 */
const prune = () => {
  const now = Date.now();
  sessions.forEach((session, key) => {
    const gone = session.finishedAt ? now - session.finishedAt > 5 * 60_000 : now > session.expiresAt + 60_000;
    if (gone) {
      release(session);
      sessions.delete(key);
    }
  });
};

/**
 * 一次查询。桥里**不做长轮询**：事件已经由 `mqtt.js` 的后台循环收进 `session.events`，
 * 这里只报当前状态，界面按自己的节奏来问。
 */
export async function qqAppCheckLoginQr(qrcodeId) {
  const key = sessionKey(String(qrcodeId || ''));
  const session = sessions.get(key);
  if (!session) return expired();
  if (session.result) return session.result;
  if (Date.now() > session.expiresAt) {
    forget(session);
    noteQrLoginStep('app:qr:check:expired');
    return expired();
  }
  const terminal = session.events.find((event) => ['canceled', 'timeout', 'loginFailed'].includes(event.type || ''));
  if (terminal) {
    forget(session);
    noteQrLoginStep('app:qr:check:terminal', { type: terminal.type });
    return expired();
  }
  const cookies = session.events.find((event) => event.type === 'cookies');
  if (cookies) {
    if (!session.exchanging) {
      session.exchanging = (async () => {
        const bag = (cookies.payload && cookies.payload.cookies) || {};
        const valueOf = (name) => {
          const entry = bag[name];
          if (entry && typeof entry === 'object') return String(entry.value ?? '');
          return typeof entry === 'string' ? entry : '';
        };
        const musicid = valueOf('qqmusic_uin');
        const token = valueOf('qqmusic_key');
        noteQrLoginStep('app:qr:check:cookies', {
          hasMusicId: Boolean(musicid),
          hasToken: Boolean(token),
          loginType: valueOf('tmeLoginType') || 'unknown',
        });
        if (!musicid || !token) throw new Error('QQ app QR: MQTT cookies missing credential');
        const credential = await resolveCredential(session.qrcodeId, musicid, token);
        const sessionData = await applySession(buildCookie(credential));
        noteQrLoginStep('app:qr:done:ok', { loginType: credential.loginType });
        const result = {
          isOk: true,
          loggedIn: true,
          code: 0,
          status: 'ok',
          message: '登录成功',
          provider: 'qq',
          session: sessionData,
          userId: credential.accountId,
          uin: credential.accountId,
          hasCookie: true,
        };
        session.result = result;
        release(session);
        return result;
      })().catch((error) => {
        // 已经确认、换票却失败：这是终态，不能当成「等待扫码」吞掉，否则界面一直转圈。
        noteQrLoginStep('app:qr:exchange:failed', { message: error?.message || String(error) });
        release(session);
        const result = {
          isOk: false,
          code: 0,
          provider: 'qq',
          status: 'error',
          retryable: false,
          message: error?.message || '登录失败',
        };
        session.result = result;
        return result;
      });
    }
    return session.exchanging;
  }
  if (session.events.some((event) => event.type === 'scanned')) {
    return { isOk: false, code: 67, refresh: false, provider: 'qq', status: 'scanned', message: '已扫码，请在手机上确认' };
  }
  return waiting();
}

/** 关掉这次登录：二维码取消、关窗口都走这里，连接立刻释放。 */
export function qqAppCancelLoginQr(qrcodeId) {
  const key = sessionKey(String(qrcodeId || ''));
  const session = sessions.get(key);
  if (session) forget(session);
}

/** 测试用：会话表是模块级单例。 */
export function resetAppLoginState() {
  sessions.forEach((session) => session.listener?.close());
  sessions.clear();
  deviceIdentity = null;
}
