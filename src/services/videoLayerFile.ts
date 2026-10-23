import { getFromCache, removeFromCache, saveToCache } from './db';
import { isCapacitorAndroid } from '../platform/runtime';
import {
    clearNativeVideoLayerFile,
    pickNativeVideoLayerFile,
    readNativeVideoLayerFile,
} from '../platform/foliaNative';

// src/services/videoLayerFile.ts
// Local video file for the video layer behind the lyrics. Two ways to keep a pick across restarts:
//
//  · File System Access API (Chromium, Electron): the pick is a FileSystemFileHandle kept in
//    IndexedDB, read again on the next start. Nothing is copied anywhere.
//  · Capacitor Android: no such API in the WebView, so the native side copies the video into the
//    app's private directory (android/.../VideoLayerFile) and hands back a loopback URL. The bytes
//    never cross the bridge, and the URL is re-asked on every start (its port is assigned per
//    process, so it must never be stored).
//
// Elsewhere (a plain browser without the picker API) the pick falls back to <input type=file> and
// lasts for the session only.

const VIDEO_LAYER_FILE_HANDLE_KEY = 'video_layer_file_handle';

type PermissionAwareFileHandle = FileSystemFileHandle & {
    queryPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
};

type OpenFilePickerWindow = Window & {
    showOpenFilePicker?: (options: {
        multiple?: boolean;
        excludeAcceptAllOption?: boolean;
        types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle[]>;
};

export type PickedVideoFile = {
    /** The picked bytes; null on Android, where the copy lives on the native side. */
    file: File | null;
    /** Android: the loopback URL of the copy in the app's private directory. Null elsewhere. */
    url: string | null;
    /** Null when the pick came from the <input> fallback and cannot be restored later. */
    handle: FileSystemFileHandle | null;
    name: string;
};

/**
 * Whether a pick can outlive this session.
 *
 * Android counts as yes even without the File System Access API: the video is copied into the
 * app's private directory instead (see the header of this file).
 */
export const canPersistVideoLayerFile = (): boolean => (
    typeof window !== 'undefined'
    && (isCapacitorAndroid() || typeof (window as OpenFilePickerWindow).showOpenFilePicker === 'function')
);

const pickWithInput = (): Promise<File | null> => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
});

/** Opens the picker for one video; null when the user cancels. Must run inside a user gesture. */
export const pickVideoLayerFile = async (): Promise<PickedVideoFile | null> => {
    if (isCapacitorAndroid()) {
        const native = await pickNativeVideoLayerFile();
        // 挑到了却用不了（太大 / 读不出来）：抛出去，界面按「无法打开该视频」提示。
        if (native.status === 'rejected') throw new Error('The picked video could not be stored');
        return native.status === 'applied' ? { file: null, url: native.url, handle: null, name: native.name } : null;
    }
    const picker = (window as OpenFilePickerWindow).showOpenFilePicker;
    if (!picker) {
        const file = await pickWithInput();
        return file ? { file, url: null, handle: null, name: file.name } : null;
    }
    try {
        const [handle] = await picker({
            multiple: false,
            types: [{
                description: 'Video',
                accept: { 'video/*': ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.ogv'] },
            }],
        });
        if (!handle) return null;
        const file = await handle.getFile();
        return { file, url: null, handle, name: file.name };
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        throw error;
    }
};

/**
 * Android: the pick stored by an earlier session, as the loopback URL of the private copy.
 * Null when there is none, or when this is not Android at all.
 */
export const readNativeVideoLayerPick = () => readNativeVideoLayerFile();

/** Android: forget the private copy (the native side deletes the file). */
export const clearNativeVideoLayerPick = () => clearNativeVideoLayerFile();

export const saveVideoLayerFileHandle = (handle: FileSystemFileHandle) => saveToCache(VIDEO_LAYER_FILE_HANDLE_KEY, handle);

export const loadVideoLayerFileHandle = () => getFromCache<FileSystemFileHandle>(VIDEO_LAYER_FILE_HANDLE_KEY);

export const clearVideoLayerFileHandle = () => removeFromCache(VIDEO_LAYER_FILE_HANDLE_KEY);

export type VideoLayerFileReadResult =
    | { status: 'ready'; file: File }
    | { status: 'needs-permission' }
    | { status: 'missing' };

/**
 * Reads the stored handle's file. Without `request` it never prompts: a handle whose read
 * permission lapsed (a browser restart outside Electron) reports `needs-permission`, and the
 * settings UI asks again from a click. `missing` means the file was moved or deleted.
 */
export const readVideoLayerFileHandle = async (
    handle: FileSystemFileHandle,
    request: boolean,
): Promise<VideoLayerFileReadResult> => {
    const permissionAware = handle as PermissionAwareFileHandle;
    let permission: PermissionState = (await permissionAware.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (permission !== 'granted' && request && permissionAware.requestPermission) {
        permission = await permissionAware.requestPermission({ mode: 'read' });
    }
    if (permission !== 'granted') return { status: 'needs-permission' };
    try {
        return { status: 'ready', file: await handle.getFile() };
    } catch {
        return { status: 'missing' };
    }
};
