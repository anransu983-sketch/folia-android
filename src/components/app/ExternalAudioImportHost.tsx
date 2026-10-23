import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { getLocalPlaylists, createLocalPlaylist, addSongsToLocalPlaylist } from '../../services/localPlaylistService';
// 导入完要广播一次「本地音乐更新」：应用里的 localSongs / localPlaylists 是内存里的一份，
// 不广播的话歌已经进了库、目标歌单的 songIds 也写好了，可页面还拿着旧的那份 —— 表现就是
// 「导入成功，但我喜欢（或刚选的那个歌单）里一首都没有」。挑文件夹导入那条路走的是
// libraryHomeActions 里的 port.refreshLocalSongs()，这一步就是它的等价物。
import { LOCAL_MUSIC_UPDATED_EVENT } from '../../services/localMusicService';
import {
    discardExternalAudioTracks,
    importExternalAudioTracks,
    isAndroidNativeRuntime,
    subscribeExternalAudio,
    takeExternalAudioTracks,
    type ExternalAudioPayload,
} from '../../services/nativeLocalMusic';
import type { LocalPlaylist } from '../../types';
import ConfirmDialog from '../shared/ConfirmDialog';
import PlaylistSelectionDialog from '../shared/PlaylistSelectionDialog';
import TextInputDialog from '../shared/TextInputDialog';

// src/components/app/ExternalAudioImportHost.tsx
// 「用 Folia 打开这个音频文件」。
//
// 原生侧（MainActivity.handleIncomingAudioIntent → FoliaNativePlugin.noteExternalAudioUris）
// 在 intent 进来的那一刻就把文件拷进了 App 私有目录 —— content:// 的读授权只在 intent
// 存活期间有效，等用户看完「是否导入」再回头读，部分 ROM 上已经作废。
//
// 所以这里要做的不是"再去读一遍文件"，而是替用户把后半段的两个问题问完：
// 1. 是否导入？（拷目已经做完了，用户说不要就得把副本删掉，见 discardExternalAudioTracks）
// 2. 导入到哪个歌单？（也可以直接关闭 —— 那样只进本机曲库）
//
// 两条取件路径都汇聚到这里：
// · 冷启动：那时页面还没加载完、一个监听者都没有，拷好的曲目由 takeExternalAudioTracks 取走；
// · 已经在前台：原生直接发 externalAudio 事件过来。

type ExternalAudioImportHostProps = {
    isDaylight: boolean;
};

const MAX_LISTED_NAMES = 3;

const ExternalAudioImportHost: React.FC<ExternalAudioImportHostProps> = ({ isDaylight }) => {
    const { t } = useTranslation();
    // 待处理的那一批（可能同时来自冷启动与前台事件，按 id 并起来）。
    const [pending, setPending] = useState<ExternalAudioPayload['tracks']>([]);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [isPlaylistOpen, setIsPlaylistOpen] = useState(false);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [playlists, setPlaylists] = useState<LocalPlaylist[]>([]);
    /** 导入要跑一会儿（要读内嵌元数据），期间不许用户连点两路；busyRef 给异步回调同步读。 */
    const busyRef = useRef(false);
    /**
     * 这一批已经处理过了。
     *
     * PlaylistSelectionDialog 选完一项之后还会再调一次 onClose（它自己就是这么收尾的），
     * 于是「选了歌单」会紧接着又跑一次「关闭 = 只进曲库」的分支 —— busyRef 那时已经复位，
     * 挡不住它：第二次会把去重后的 0 首当成结果，把「已导入 N 首到《X》」冲成
     * 「已经在本机曲库里了」。这里是这道闸。
     */
    const settledRef = useRef(false);
    /**
     * 用户已经点头了。
     *
     * 「是否导入」那一页的关闭（点叉、点背景、返回键）是要把拷好的副本删掉的；可用户一旦
     * 按了「导入」，那一页还要 await 一次歌单列表才翻页 —— 这中间它仍然是打开的，手指碰
     * 到背景就会走关闭分支，把待会儿要读的副本删了：歌照样进库、照样加进歌单，却一首都
     * 放不出来。点了头之后关闭就只是关掉，不再删文件。
     */
    const confirmedRef = useRef(false);
    /** 翻页那一瞬间有 await：先把关闭按钮与背景点掉，别让人手滑把流程打断。 */
    const [isStepping, setIsStepping] = useState(false);

    const mergePending = useCallback((incoming: ExternalAudioPayload['tracks']) => {
        if (incoming.length === 0) return;
        setPending(current => {
            const seen = new Set(current.map(track => track.id));
            const appended = incoming.filter(track => (track.id ? !seen.has(track.id) : false));
            return appended.length > 0 ? [...current, ...appended] : current;
        });
        // 新的一批进来：上一批的「已处理」标记作废（已经处理完的那一份不会再来一遍）。
        settledRef.current = false;
        confirmedRef.current = false;
        setIsConfirmOpen(true);
    }, []);

    useEffect(() => {
        if (!isAndroidNativeRuntime()) return undefined;
        const unsubscribe = subscribeExternalAudio(payload => mergePending(payload.tracks));
        // 冷启动那一路：这一次被原生攒着、还没被领走的。
        void takeExternalAudioTracks().then(payload => mergePending(payload.tracks));
        return unsubscribe;
    }, [mergePending]);

    const reset = useCallback(() => {
        setPending([]);
        setIsConfirmOpen(false);
        setIsPlaylistOpen(false);
        setIsCreateOpen(false);
    }, []);

    /** 用户摇头：连已经在私有目录里的副本一起收回（点过头之后就不收了，见 confirmedRef）。 */
    const handleDecline = useCallback(async () => {
        const tracks = pending;
        const shouldDiscard = !confirmedRef.current;
        reset();
        if (shouldDiscard && tracks.length > 0) await discardExternalAudioTracks(tracks);
    }, [pending, reset]);

    const finishImport = useCallback(async (playlistId: string | null, playlistName?: string) => {
        if (busyRef.current || settledRef.current) return;
        busyRef.current = true;
        settledRef.current = true;
        try {
            const result = await importExternalAudioTracks(pending);
            // 加歌单要用 resolved，不是 fresh：同一个文件再打开一次时它已经在曲库里了
            // （fresh 为空），可「加进这个歌单」这件事还得照做 —— 否则表现就是
            // 「提示已经在曲库里了，歌单里却一首都没有」。
            const imported = result.resolved;
            const added = result.fresh.length;
            if (imported.length === 0) {
                setStatusMessage({
                    type: 'success',
                    text: t('localMusic.externalAlreadyInLibrary'),
                    nonce: Date.now(),
                });
                reset();
                return;
            }
            let targetName = playlistName ?? '';
            if (playlistId) {
                try {
                    const updated = await addSongsToLocalPlaylist(playlistId, imported);
                    if (updated) targetName = updated.name;
                } catch (error) {
                    console.warn('[ExternalAudioImport] Failed to add imported songs to playlist', error);
                }
            }
            // 写完了才广播：应用重读曲目与歌单，歌才会真的出现在刚选的那个歌单里。
            window.dispatchEvent(new CustomEvent(LOCAL_MUSIC_UPDATED_EVENT));
            setStatusMessage({
                type: 'success',
                text: targetName
                    ? (added > 0
                        ? t('localMusic.externalImportedToPlaylist', { count: added, name: targetName })
                        : t('localMusic.externalAlreadyAddedToPlaylist', { count: imported.length, name: targetName }))
                    : (added > 0
                        ? t('localMusic.externalImported', { count: added })
                        : t('localMusic.externalAlreadyInLibrary')),
                nonce: Date.now(),
            });
            reset();
        } catch (error) {
            setStatusMessage({
                type: 'error',
                text: t('localMusic.externalImportFailed', {
                    message: error instanceof Error ? error.message : String(error),
                }),
                nonce: Date.now(),
            });
        } finally {
            busyRef.current = false;
        }
    }, [pending, reset, t]);

    /** 选歌单那一页的数据：每次打开都重新读，别让用户刚新建好的歌单不出现。 */
    const openPlaylistStep = useCallback(async () => {
        confirmedRef.current = true;
        setIsStepping(true);
        let existing: LocalPlaylist[] = [];
        try {
            existing = await getLocalPlaylists();
        } catch (error) {
            // 歌单读不出来也要让人能把歌导进去：空列表走「新建歌单」那条路照样成立。
            console.warn('[ExternalAudioImport] Failed to load local playlists', error);
        } finally {
            setIsStepping(false);
        }
        setPlaylists(existing);
        setIsConfirmOpen(false);
        setIsPlaylistOpen(true);
        // 翻页这一段的保护到此为止：第二页上再点关闭就是真的取消，副本该收回。
        confirmedRef.current = false;
    }, []);

    /**
     * 选歌单那一页的关闭 = 取消（不导入，副本收回）。
     *
     * 这一页以前「关闭就是只进曲库」，于是用户点取消/点叉/按返回键，歌照样进了本机曲库
     * —— 现在「只进本机曲库」是列表最下面那个按钮，关闭才真的是什么都不要。
     * 选完歌单时组件还会再调一次 onClose，那一趟由 settledRef / busyRef 挡掉。
     */
    const handlePlaylistCancel = useCallback(() => {
        if (busyRef.current || settledRef.current) return;
        void handleDecline();
    }, [handleDecline]);

    const summary = useMemo(() => {
        const names = pending.map(track => track.fileName || track.id);
        const head = names.slice(0, MAX_LISTED_NAMES).join('、');
        const rest = Math.max(0, names.length - MAX_LISTED_NAMES);
        return { head, rest, count: names.length, firstName: names[0] ?? '' };
    }, [pending]);

    const playlistEntries = useMemo(() => playlists.map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        description: `${playlist.songIds.length} ${t('playlist.tracks')}`,
    })), [playlists, t]);

    if (!isAndroidNativeRuntime()) return null;

    return (
        <div className="pointer-events-auto">
            <ConfirmDialog
                isOpen={isConfirmOpen && pending.length > 0}
                onClose={() => void handleDecline()}
                onConfirm={() => void openPlaylistStep()}
                isDaylight={isDaylight}
                closeDisabled={isStepping}
                title={t('localMusic.externalOpenTitle')}
                description={(
                    <>
                        <span>
                            {summary.count === 1
                                ? t('localMusic.externalOpenConfirm_one', { name: summary.firstName })
                                : t('localMusic.externalOpenConfirm_other', { count: summary.count })}
                        </span>
                        {summary.count > 1 && (
                            <span className="mt-1 block text-xs opacity-60">
                                {t('localMusic.externalOpenFileList', {
                                    names: summary.head,
                                    more: summary.rest > 0
                                        ? ` ${t('localMusic.externalOpenFileMore', { count: summary.rest })}`
                                        : '',
                                })}
                            </span>
                        )}
                    </>
                )}
                confirmText={t('localMusic.externalImportAction')}
                cancelText={t('localMusic.cancel')}
            />

            <PlaylistSelectionDialog
                isOpen={isPlaylistOpen}
                onClose={handlePlaylistCancel}
                isDaylight={isDaylight}
                title={t('localMusic.externalPickPlaylistTitle')}
                description={t('localMusic.externalPickPlaylistHint')}
                playlists={playlistEntries}
                onSelect={async playlistId => {
                    await finishImport(String(playlistId));
                }}
                onCreate={() => {
                    setIsPlaylistOpen(false);
                    setIsCreateOpen(true);
                }}
                createLabel={t('localMusic.createPlaylist')}
                secondaryAction={{
                    label: t('localMusic.externalLibraryOnly'),
                    onSelect: async () => {
                        await finishImport(null);
                    },
                }}
            />

            <TextInputDialog
                isOpen={isCreateOpen}
                onClose={() => {
                    // 从「新建歌单」退回来：回到选歌单那一页，别把流程默默掐断。
                    setIsCreateOpen(false);
                    setIsPlaylistOpen(true);
                }}
                isDaylight={isDaylight}
                title={t('localMusic.createPlaylist')}
                description={t('localMusic.enterPlaylistName')}
                placeholder={t('localMusic.enterPlaylistName')}
                confirmLabel={t('localMusic.save')}
                onConfirm={async name => {
                    const trimmed = name.trim();
                    if (!trimmed) return;
                    const created = await createLocalPlaylist(trimmed, []);
                    await finishImport(created.id, created.name);
                }}
            />
        </div>
    );
};

export default ExternalAudioImportHost;
