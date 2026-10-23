import { isCapacitorAndroid } from './runtime';

// src/platform/nativeFileSave.ts
// 安卓上「存到哪儿」这一问。
//
// WebView 里导出文件一直走 `<a download>`：安卓上它要么静默丢进 Download、要么干脆没有反应，
// 用户点「导出歌词」从头到尾看不到任何「保存到哪儿」的界面。原生侧加了
// FoliaNativePlugin.saveFile（系统的 ACTION_CREATE_DOCUMENT，即 Storage Access Framework），
// 由系统弹一张保存位置选择器，选完原生把字节写进用户给的那个 URI。
//
// 文本走 content（原生按 UTF-8 编码），二进制走 contentBase64（批量导出那个 zip）。
// 桌面 / 网页端拿不到这个插件时返回 'unavailable'，调用方照旧回落到 Blob 下载。

type SaveFileResponse = {
    saved?: boolean;
    cancelled?: boolean;
    uri?: string;
    name?: string;
};

type SaveFilePayload = {
    fileName: string;
    mimeType?: string;
    content?: string;
    contentBase64?: string;
};

type SaveFilePlugin = {
    saveFile?: (options: SaveFilePayload) => Promise<SaveFileResponse>;
};

/** 'saved' 存好了 / 'cancelled' 用户自己关掉了选择器 / 'unavailable' 这一端没有这个能力。 */
export type SaveFileOutcome = 'saved' | 'cancelled' | 'unavailable';

const getPlugin = (): SaveFilePlugin | null => (
    ((window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor?.Plugins?.FoliaNative as SaveFilePlugin) ?? null
);

/** Blob → base64（不带 data: 前缀）。二进制那条路要用：桥上只能传字符串。 */
const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
        const result = String(reader.result ?? '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Cannot read blob'));
    reader.readAsDataURL(blob);
});

/**
 * 弹系统的保存位置选择器并把内容写进去。
 *
 * 只有安卓会真的弹；别的一端（桌面、网页）一律 'unavailable'，好让调用方自己回落。
 */
export const saveFileWithSystemPicker = async (options: {
    fileName: string;
    mimeType?: string;
    /** 文本：直接给字符串，原生按 UTF-8 写（中文歌词走这条路）。 */
    content?: string;
    /** 二进制：给 Blob，这里转成 base64。与 content 二选一。 */
    blob?: Blob;
}): Promise<SaveFileOutcome> => {
    if (!isCapacitorAndroid()) return 'unavailable';
    const plugin = getPlugin();
    if (!plugin?.saveFile) return 'unavailable';
    try {
        const payload: SaveFilePayload = { fileName: options.fileName };
        if (options.mimeType) payload.mimeType = options.mimeType;
        if (options.blob) {
            payload.contentBase64 = await blobToBase64(options.blob);
        } else {
            payload.content = options.content ?? '';
        }
        const response = await plugin.saveFile(payload);
        return response?.saved === true ? 'saved' : 'cancelled';
    } catch (error) {
        console.warn('[nativeFileSave] 保存失败', error);
        // 写失败也算「这一趟没存成」，但不该冒成「没有歌词」：调用方据此不弹错误提示。
        return 'cancelled';
    }
};
