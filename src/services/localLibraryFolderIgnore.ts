import type { LocalLibrarySnapshotNode } from '../types';
import { getLocalLibrarySnapshot, saveLocalLibrarySnapshot } from './db';

// src/services/localLibraryFolderIgnore.ts

export const normalizeLocalFolderPath = (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

let pendingMutation: Promise<unknown> = Promise.resolve();

// Serialize scans, ignore changes and hydration writes so an older scan cannot undo a deletion.
export function runLocalFolderMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = pendingMutation.then(operation, operation);
    pendingMutation = result.catch(() => undefined);
    return result;
}

export const isLocalFolderIgnored = (path: string, ignoredPaths: readonly string[]) => (
    ignoredPaths.some(ignored => path === ignored || path.startsWith(`${ignored}/`))
);

/**
 * 「删除文件夹」的墓碑：根目录被删过这件事本身要记下来。
 *
 * 光删掉库里的歌不够 —— 安卓上「刷新」就是整库重扫一次（resyncAllFolders →
 * scanAndroidDeviceMusic），MediaStore 里的歌一首不少，重扫就全回来了。桌面端虽然靠删
 * 目录句柄挡住了自动重扫，但换个同名的目录再导一次就该让它回来，所以两端都走这份记录。
 *
 * 记在快照里而不是另开一张表：快照本来就是「这个根目录上次长什么样」，加一个字段就够，
 * 不用动 Dexie 的 schema。
 */
export async function markLocalRootRemoved(rootFolderName: string): Promise<void> {
    const root = normalizeLocalFolderPath(rootFolderName).split('/')[0];
    if (!root) return;
    // 快照内容一并清掉（跟以前直接删快照一样，重新导入是从零开始）：留下的只有墓碑这一位。
    await saveLocalLibrarySnapshot({
        rootFolderName: root,
        scannedAt: 0,
        ignoredFolderPaths: [],
        tree: { name: root, relativePath: root, hash: '', files: [], children: [] },
        rootRemoved: true,
    });
}

/** 这个根目录删过吗（只有快照上带着墓碑才算）。 */
export async function isLocalRootRemoved(rootFolderName: string): Promise<boolean> {
    const root = normalizeLocalFolderPath(rootFolderName).split('/')[0];
    if (!root) return false;
    const snapshot = await getLocalLibrarySnapshot(root);
    return snapshot?.rootRemoved === true;
}

/** 用户显式把它要回来了（重新导入 / 再扫一次设备音乐）：墓碑撤掉。 */
export async function clearLocalRootRemoved(rootFolderName: string): Promise<void> {
    const root = normalizeLocalFolderPath(rootFolderName).split('/')[0];
    if (!root) return;
    const snapshot = await getLocalLibrarySnapshot(root);
    if (!snapshot?.rootRemoved) return;
    await saveLocalLibrarySnapshot({ ...snapshot, rootRemoved: false });
}

// Persist literal folder paths separately from disk rules, retaining an empty tree entry for recovery.
export async function setLocalFolderIgnored(folderPath: string, ignored: boolean): Promise<void> {
    const path = normalizeLocalFolderPath(folderPath);
    const rootFolderName = path.split('/')[0];
    if (!path.includes('/')) return;
    const snapshot = await getLocalLibrarySnapshot(rootFolderName);
    const ignoredPaths = new Set(snapshot?.ignoredFolderPaths || []);
    if (ignored) ignoredPaths.add(path);
    else ignoredPaths.delete(path);

    const updateNode = (node: LocalLibrarySnapshotNode): LocalLibrarySnapshotNode => {
        if (node.relativePath === path) {
            return { ...node, ignored, files: [], children: [], hash: '' };
        }
        return { ...node, children: node.children.map(updateNode) };
    };
    const tree = updateNode(snapshot?.tree || {
        name: rootFolderName, relativePath: rootFolderName, hash: '', files: [], children: [],
    });
    let parent = tree;
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
        const relativePath = parts.slice(0, index + 1).join('/');
        let child = parent.children.find(node => node.relativePath === relativePath);
        if (!child) {
            child = { name: parts[index], relativePath, hash: '', files: [], children: [] };
            parent.children.push(child);
        }
        parent = child;
    }
    parent.ignored = ignored;
    await saveLocalLibrarySnapshot({
        rootFolderName,
        scannedAt: snapshot?.scannedAt || 0,
        ignoredFolderPaths: [...ignoredPaths],
        lyricFormatOrder: snapshot?.lyricFormatOrder,
        tree,
    });
}
