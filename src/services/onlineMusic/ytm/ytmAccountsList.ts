// src/services/onlineMusic/ytm/ytmAccountsList.ts
//
// 读 `/account/accounts_list` 的**原始**答复：这次请求被当作谁答的、登录的是谁。
//
// 判据与形状都照桌面端 electron/ytm/webPages.cjs —— 那边是拿真账号量过的：
// 平台对「它不认的登录」是回 200 加一张游客的答复，而不是报错，所以能分辨两者的
// 只有答复自己带的 `logged_in` 标记，账号本体则在 actions 里那张账户菜单里。
// 请求仍由 youtubei.js 的会话发（见 ytmInPageRuntime），这里只读答复，不发请求。

/** accounts_list 答复里读到的账号（id 用平台给的不透明 id，不做摘要）。 */
export type YtmAccountFromList = {
    id: string;
    /** 账号名；答复里连名字带 handle 都没有时是空串，由调用方决定怎么称呼。 */
    nickname: string;
    avatarUrl?: string;
};

type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord | null => (
    value && typeof value === 'object' ? value as RawRecord : null
);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** 答复里一处文字节点的读法：simpleText 或 runs 拼起来（与桌面端 textOf 同一条）。 */
const textOf = (node: unknown): string => {
    const record = asRecord(node);
    if (!record) return '';
    if (typeof record.simpleText === 'string') return record.simpleText;
    if (Array.isArray(record.runs)) {
        return record.runs.map((run) => {
            const text = asRecord(run)?.text;
            return typeof text === 'string' ? text : '';
        }).join('');
    }
    return '';
};

/**
 * 这次答复是按谁的身份给的：'1' 是登录着的账号、'0' 是没人登录；答复里没这个标记
 * 时是 undefined —— 那就谁也说不准，不能拿它判任何一边。
 */
export const ytmSignedInMarkOf = (data: unknown): string | undefined => {
    const context = asRecord(asRecord(data)?.responseContext);
    const services = asArray(context?.serviceTrackingParams);
    const feedback = services
        .map(asRecord)
        .find((service) => service?.service === 'GFEEDBACK');
    const params = asArray(feedback?.params);
    const mark = params
        .map(asRecord)
        .find((param) => param?.key === 'logged_in')?.value;
    return typeof mark === 'string' ? mark : undefined;
};

/** 答复里被选中的那个账号（多账号时 isSelected 的优先，否则第一个）；没有就是 null。 */
export const accountFromYtmAccountsList = (data: unknown): YtmAccountFromList | null => {
    const items: RawRecord[] = [];
    for (const action of asArray(asRecord(data)?.actions)) {
        const menu = asRecord(asRecord(asRecord(action)?.getMultiPageMenuAction)?.menu);
        const sections = asArray(asRecord(menu?.multiPageMenuRenderer)?.sections);
        for (const section of sections) {
            const groups = asArray(asRecord(asRecord(section)?.accountSectionListRenderer)?.contents);
            for (const group of groups) {
                const entries = asArray(asRecord(asRecord(group)?.accountItemSectionRenderer)?.contents);
                for (const entry of entries) {
                    const item = asRecord(asRecord(entry)?.accountItem);
                    if (item) items.push(item);
                }
            }
        }
    }
    const account = items.find((item) => item.isSelected === true) ?? items[0];
    if (!account) return null;
    const nickname = textOf(account.accountName);
    const handle = textOf(account.channelHandle);
    const endpoint = asRecord(asRecord(account.serviceEndpoint)?.selectActiveIdentityEndpoint);
    const tokens = asArray(endpoint?.supportedTokens);
    const gaiaId = tokens
        .map((token) => asRecord(asRecord(token)?.accountStateToken)?.obfuscatedGaiaId)
        .find((value): value is string => typeof value === 'string' && value.length > 0);
    const thumbnails = asArray(asRecord(account.accountPhoto)?.thumbnails);
    const lastThumb = asRecord(thumbnails[thumbnails.length - 1]);
    const avatarUrl = typeof lastThumb?.url === 'string' ? lastThumb.url : undefined;
    return {
        id: gaiaId ?? (handle || nickname),
        nickname: nickname || handle,
        avatarUrl,
    };
};
