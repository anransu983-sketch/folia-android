/**
 * MQTT 5 over WebSocket 的最小实现，只够 QQ 音乐 App 扫码（三合一那张码）用。
 *
 * 为什么需要它：QQ 音乐 App 的登录码不是一张普通的图片 —— 它绑着一条 MQTT 会话，
 * 扫码、确认、下发换票令牌全在那条长连接上推过来。上游（`@yakult-green-tea/qq-music-api`
 * 的 `mqtt` 模块）也是这套协议：CONNECT 用 auth method `pass` 带上 tme 的几项 user
 * property（`tmeAppID` / `hashTag` / `userID` 都填二维码 id），SUBSCRIBE 到
 * `management.qrcode_login/<qrcodeId>`（unicast，不重放），然后收 PUBLISH。
 *
 * 🔴 订阅必须在二维码显示**之前**成立：CONNECT 请求的是 clean session、订阅是 unicast，
 * 断连期间的 `scanned` / `cookies` 上游既不保留也不补送。所以 `openQrListener` 等的是
 * SUBACK，不是连接建立。
 *
 * 本文件不 import 任何东西：纯字节层，能脱开桥单独跑单测（`test/unit/nativeBridge/qqAppLoginMqtt.test.ts`）。
 */

export const MQTT_HOST = 'mu.y.qq.com';
export const MQTT_INITIAL_PATH = '/ws/handshake';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** MQTT 的可变长度整数（每字节 7 位，最高位是「后面还有」）。 */
export const encodeVarint = (input) => {
  const bytes = [];
  let value = input;
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Uint8Array.from(bytes);
};

/** 读一个可变长度整数；字节不够时回 null（网络分片里很常见，调用方据此等下一片）。 */
export const decodeVarint = (buffer, offset = 0) => {
  let multiplier = 1;
  let value = 0;
  for (let bytes = 0; bytes < 4; bytes += 1) {
    if (offset + bytes >= buffer.length) return null;
    const digit = buffer[offset + bytes];
    value += (digit & 0x7f) * multiplier;
    if ((digit & 0x80) === 0) return { value, bytes: bytes + 1 };
    multiplier *= 128;
  }
  throw new Error('Malformed MQTT variable integer');
};

const joinBytes = (chunks) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/** MQTT 的 UTF-8 字段：两字节大端长度 + 正文。 */
const encodeUtf8 = (value) => {
  const data = textEncoder.encode(String(value));
  return joinBytes([Uint8Array.of((data.length >> 8) & 0xff, data.length & 0xff), data]);
};

const readUInt16 = (buffer, offset) => (buffer[offset] << 8) | buffer[offset + 1];

const readUtf8 = (buffer, offset) => {
  const length = readUInt16(buffer, offset);
  const start = offset + 2;
  return { value: textDecoder.decode(buffer.subarray(start, start + length)), next: start + length };
};

/** 属性块：0x15 = 认证方式，0x26 = 用户属性（键值都是 UTF-8 字符串）。 */
const encodeProperties = (authMethod, properties) => {
  const chunks = [];
  if (authMethod) chunks.push(Uint8Array.of(0x15), encodeUtf8(authMethod));
  for (const [key, value] of properties) chunks.push(Uint8Array.of(0x26), encodeUtf8(key), encodeUtf8(value));
  const data = joinBytes(chunks);
  return joinBytes([encodeVarint(data.length), data]);
};

const wrapPacket = (header, body) => joinBytes([Uint8Array.of(header), encodeVarint(body.length), body]);

/**
 * CONNECT：协议版本 5、clean session、keepalive 45 秒；认证方式是 `pass`，凭据就是那几项
 * user property（上游的 `business=management` / `clientTag=management.user`）。
 */
export const buildConnectPacket = (clientId, qrcodeId) => {
  const properties = encodeProperties('pass', [
    ['tmeAppID', 'qqmusic'],
    ['business', 'management'],
    ['hashTag', qrcodeId],
    ['clientTag', 'management.user'],
    ['userID', qrcodeId],
  ]);
  return wrapPacket(0x10, joinBytes([
    encodeUtf8('MQTT'),
    Uint8Array.of(0x05, 0x02),
    Uint8Array.of(0x00, 45),
    properties,
    encodeUtf8(clientId),
  ]));
};

/** SUBSCRIBE：QoS 0、`authorization=tmelogin`、`pubsub=unicast`；包 id 固定 1，一条连接只订阅一次。 */
export const buildSubscribePacket = (qrcodeId) => {
  const properties = encodeProperties(null, [['authorization', 'tmelogin'], ['pubsub', 'unicast']]);
  return wrapPacket(0x82, joinBytes([
    Uint8Array.of(0x00, 0x01),
    properties,
    encodeUtf8(`management.qrcode_login/${qrcodeId}`),
    Uint8Array.of(0x00),
  ]));
};

/** PINGREQ：0xc0 0x00。 */
export const PING_PACKET = Uint8Array.of(0xc0, 0x00);

const skipProperty = (buffer, offset, id) => {
  if ([0x03, 0x08, 0x12, 0x15, 0x1a, 0x1c, 0x1f].includes(id)) return readUtf8(buffer, offset).next;
  if ([0x13, 0x21, 0x22, 0x23].includes(id)) return offset + 2;
  if ([0x02, 0x11, 0x18, 0x27].includes(id)) return offset + 4;
  if ([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a].includes(id)) return offset + 1;
  if ([0x09, 0x16].includes(id)) return offset + 2 + readUInt16(buffer, offset);
  if (id === 0x0b) {
    const value = decodeVarint(buffer, offset);
    if (!value) throw new Error('Truncated MQTT subscription identifier');
    return offset + value.bytes;
  }
  throw new Error(`Unsupported MQTT property 0x${id.toString(16)}`);
};

const parseProperties = (buffer, offset) => {
  const length = decodeVarint(buffer, offset);
  if (!length) throw new Error('Truncated MQTT properties');
  let cursor = offset + length.bytes;
  const end = cursor + length.value;
  const userProperties = {};
  const values = { userProperties };
  while (cursor < end) {
    const id = buffer[cursor];
    cursor += 1;
    if (id === 0x26) {
      const key = readUtf8(buffer, cursor);
      const value = readUtf8(buffer, key.next);
      userProperties[key.value] = value.value;
      cursor = value.next;
    } else if (id === 0x1c || id === 0x1f) {
      const value = readUtf8(buffer, cursor);
      values[id === 0x1c ? 'serverReference' : 'reasonString'] = value.value;
      cursor = value.next;
    } else cursor = skipProperty(buffer, cursor, id);
  }
  return { values, next: end };
};

/** 一片 WebSocket 消息里可能有半个包、也可能有好几个包，剩下的留给下一次。 */
export const splitPackets = (buffer) => {
  const packets = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const remaining = decodeVarint(buffer, cursor + 1);
    if (!remaining) break;
    const end = cursor + 1 + remaining.bytes + remaining.value;
    if (end > buffer.length) break;
    packets.push(buffer.subarray(cursor, end));
    cursor = end;
  }
  return { packets, rest: buffer.subarray(cursor) };
};

export const parseConnack = (packet) => {
  const remaining = decodeVarint(packet, 1);
  if (!remaining) throw new Error('Truncated MQTT CONNACK');
  const offset = 1 + remaining.bytes;
  return { reasonCode: packet[offset + 1], ...parseProperties(packet, offset + 2).values };
};

/** PUBLISH：主题跳过去，QoS>0 时跳过包 id，正文按 JSON 解析；事件类型在 user property `type` 上。 */
export const parsePublish = (packet) => {
  const remaining = decodeVarint(packet, 1);
  if (!remaining) throw new Error('Truncated MQTT PUBLISH');
  let cursor = 1 + remaining.bytes;
  cursor = readUtf8(packet, cursor).next;
  if (((packet[0] >> 1) & 0x03) > 0) cursor += 2;
  const properties = parseProperties(packet, cursor);
  const raw = textDecoder.decode(packet.subarray(properties.next));
  let payload = null;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      payload = null;
    }
  }
  return { type: properties.values.userProperties.type || null, payload };
};

const toBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
};

/**
 * 包队列：把「等下一个包」写成 Promise，超时即 reject。
 * 先建队列、再把它的 handlers 交给连接，是因为第一帧可能在 `connect` resolve 之前就到了。
 */
export const createPacketQueue = () => {
  let buffered = new Uint8Array(0);
  const packets = [];
  const waiters = [];
  let terminalError = null;
  const settle = () => {
    while (waiters.length && packets.length) waiters.shift().resolve(packets.shift());
    while (terminalError && waiters.length) waiters.shift().reject(terminalError);
  };
  const push = (value) => {
    const split = splitPackets(joinBytes([buffered, toBytes(value)]));
    buffered = split.rest;
    packets.push(...split.packets);
    settle();
  };
  const fail = (error) => {
    terminalError = error;
    settle();
  };
  const next = (timeoutMs) => {
    if (packets.length) return Promise.resolve(packets.shift());
    if (terminalError) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('MQTT packet timeout'));
      }, timeoutMs);
      waiter.resolve = (packet) => {
        clearTimeout(timer);
        resolve(packet);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  };
  return { push, fail, next };
};

const HANDSHAKE_TIMEOUT_MS = 20_000;
const PING_INTERVAL_MS = 30_000;

const defaultOpenSocket = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, 'mqtt');
  socket.binaryType = 'arraybuffer';
  const timer = setTimeout(() => {
    try {
      socket.close();
    } catch (_) {
      /* 已经断了 */
    }
    reject(new Error('MQTT handshake timeout'));
  }, HANDSHAKE_TIMEOUT_MS);
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    resolve(socket);
  }, { once: true });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    reject(new Error('MQTT WebSocket error'));
  }, { once: true });
});

/** 重定向：CONNACK 用 0x9c / 0x9d + `serverReference` 让客户端换一条路径重连（最多 3 跳）。 */
const redirectPath = (path, reference) => {
  const parts = path.replace(/\/$/, '').split('/');
  if ((parts[parts.length - 1] || '').includes(':')) parts[parts.length - 1] = reference;
  else parts.push(reference);
  return parts.join('/');
};

const randomDigits = (count) => {
  let out = '';
  for (let index = 0; index < count; index += 1) out += Math.floor(Math.random() * 10);
  return out;
};

const connectMqtt = async (qrcodeId, openSocket) => {
  let path = MQTT_INITIAL_PATH;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const queue = createPacketQueue();
    const socket = await openSocket(`wss://${MQTT_HOST}${path}`);
    socket.addEventListener('message', (event) => queue.push(event.data));
    socket.addEventListener('close', () => queue.fail(new Error('MQTT WebSocket closed')));
    socket.addEventListener('error', () => queue.fail(new Error('MQTT WebSocket error')));
    socket.send(buildConnectPacket(`${Date.now()}${randomDigits(4)}`, qrcodeId));
    const connack = parseConnack(await queue.next(HANDSHAKE_TIMEOUT_MS));
    const reasonCode = Number(connack.reasonCode ?? -1);
    if (reasonCode === 0) return { socket, queue };
    try {
      socket.close();
    } catch (_) {
      /* 已经断了 */
    }
    const reference = connack.serverReference || '';
    if (![0x9c, 0x9d].includes(reasonCode) || !reference || redirects === 3) {
      throw new Error(`MQTT CONNACK rejected: 0x${reasonCode.toString(16)}`);
    }
    path = redirectPath(path, reference);
  }
  throw new Error('MQTT redirect limit exceeded');
};

/**
 * 连上、订阅、**等到 SUBACK** 再把句柄交出去；之后在后台收事件，直到出现终态或超时。
 * `ready` 不单独暴露：调用方要在拿到句柄之前就知道订阅成立，所以这个函数本身就是 await 的点。
 */
export const openQrListener = async (qrcodeId, onEvent, timeoutMs, options = {}) => {
  const openSocket = options.openSocket || defaultOpenSocket;
  const { socket, queue } = await connectMqtt(qrcodeId, openSocket);
  let closed = false;
  let ping = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    try {
      socket.close();
    } catch (_) {
      /* 已经断了 */
    }
  };
  try {
    socket.send(buildSubscribePacket(qrcodeId));
    for (;;) {
      const packet = await queue.next(HANDSHAKE_TIMEOUT_MS);
      const type = packet[0] >> 4;
      if (type === 9) {
        const reasonCode = packet[packet.length - 1] ?? 0x80;
        if (reasonCode >= 0x80) throw new Error(`MQTT SUBACK rejected: 0x${reasonCode.toString(16)}`);
        break;
      }
      if (type === 3) onEvent(parsePublish(packet));
    }
  } catch (error) {
    close();
    throw error;
  }
  // 订阅成立之后才宣告「等扫码」：之前的事件没人会收到，写进事件列只会让调用方误判。
  onEvent({ type: 'waiting', payload: null });
  ping = setInterval(() => {
    if (closed) return;
    try {
      socket.send(PING_PACKET);
    } catch (_) {
      close();
    }
  }, PING_INTERVAL_MS);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  void (async () => {
    let terminal = false;
    while (!closed && Date.now() < deadline) {
      let packet = null;
      try {
        packet = await queue.next(Math.max(1, deadline - Date.now()));
      } catch (_) {
        break;
      }
      if (!packet || packet[0] >> 4 !== 3) continue;
      const event = parsePublish(packet);
      onEvent(event);
      if (['cookies', 'canceled', 'timeout', 'loginFailed'].includes(event.type || '')) {
        terminal = true;
        break;
      }
    }
    // 只有「等到了时限」才算超时：收到终态之后再补一条 timeout，调用方会以为是码过期了。
    if (!closed && !terminal) onEvent({ type: 'timeout', payload: null });
    close();
  })().catch(() => undefined);
  return { close };
};
