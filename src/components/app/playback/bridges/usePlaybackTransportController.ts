import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { PlayerState } from '../../../../types';
import { setStatusMessage as setStatusMsg } from '../../../../stores/useStatusMessageStore';
import { setPlayerState } from '../../../../stores/usePlaybackStore';
import { useTranslation } from 'react-i18next';
import { usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { currentTime } from '../../../../stores/motionSignals';
import { markProgrammaticPause, playbackFade, type PlaybackFadeSettleReason } from '../../../../services/playbackFade';
import { getPlaybackSongKey } from '../../../../utils/appPlaybackGuards';
import type { OnlineRecovery, OnlineRecoveryOptions } from '../restore/createOnlineRecoveryController';
import type { OnlineFailure } from '../../../../services/onlineMusic/failure/onlineFailureCase';
import { onlineFailureToast } from '../source/onlineFailureToast';
import { nativePlaybackEngine } from '../../../../services/playbackEngine/nativePlaybackEngine';

// src/components/app/playback/bridges/usePlaybackTransportController.ts

/**
 * 等音频上下文 resume 的上限（毫秒）。
 *
 * 这个 Promise **不保证会推进**（与 `audioWorklet.addModule()` 落在 suspended 的 context 上
 * 是同一类问题）：应用退到后台很久之后再点播放，它可能一直不落地。所以只等这么久。
 */
const AUDIO_CONTEXT_RESUME_GRACE_MS = 1200;

type UsePlaybackTransportControllerParams = {
    stageActiveEntryKind: string | null;
    isNowPlayingStageActive: boolean;
    audioRef: RefObject<HTMLAudioElement | null>;
    audioContextRef: MutableRefObject<AudioContext | null>;
    stageLyricsClockRef: MutableRefObject<{
        startTimeSec: number;
        endTimeSec: number;
        baseTimeSec: number;
        startedAtMs: number | null;
    }>;
    setupAudioAnalyzer: () => void;
    syncOutputGain: (targetVolume: number, smoothing?: number) => void;
    getTargetPlaybackVolume: () => number;
    shouldRefreshCurrentOnlineAudioSource: () => boolean;
    recoverOnlinePlaybackSource: (options: OnlineRecoveryOptions) => Promise<OnlineRecovery>;
    getSyntheticStageLyricsTime: () => number;
    syncStageLyricsClock: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    /**
     * Handles a pause that lands during an automix blend, returning true when it did.
     *
     * Mid-blend `audioRef` names the deck the next track is ARRIVING on, so the pause below would
     * stop a deck the listener cannot hear and leave the one they can hear playing on into the
     * next song - "I pressed pause and it jumped to the next track". This cancels the blend back
     * onto the deck still sounding the displayed track and pauses that, the same cancel a mid-blend
     * seek uses. Returns false (and the ordinary pause runs) when no blend is in flight.
     */
    pauseDuringTransition?: () => boolean;
    /** True while a blend is audible on the deck no control points at. Such a pause still needs the fade. */
    isTransitionAudible?: () => boolean;
    /**
     * 这一首是不是由原生 ExoPlayer 在播（P1）。
     *
     * 传 ref 而不是布尔值：resume/pause 是 useCallback，跟着开关换身份会把整批订阅重建。
     * 原生模式下元素是空的（没有 src），`audioRef.current.play()` 只会 reject，
     * 所以这两条路径必须在碰到元素之前就分出去。
     */
    nativeTakesRef?: MutableRefObject<boolean>;
};

// Owns play and pause transport behavior across main playback and Stage lyric-only playback.
export function usePlaybackTransportController({
    stageActiveEntryKind,
    isNowPlayingStageActive,
    audioRef,
    audioContextRef,
    stageLyricsClockRef,
    setupAudioAnalyzer,
    syncOutputGain,
    getTargetPlaybackVolume,
    shouldRefreshCurrentOnlineAudioSource,
    recoverOnlinePlaybackSource,
    getSyntheticStageLyricsTime,
    syncStageLyricsClock,
    pauseDuringTransition,
    isTransitionAudible,
    nativeTakesRef,
}: UsePlaybackTransportControllerParams) {
    // Read here rather than passed in: store fields, a module-level motion signal, or i18n.
    const { t } = useTranslation();
    const activePlaybackContext = usePlaybackStore(state => state.activePlaybackContext);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const duration = usePlaybackStore(state => state.duration);
    const transportRevision = useRef(0);
    const wantsPlayback = useRef(false);
    /**
     * 在后台按了播放、但音频上下文拉不起来时留下的「回到前台补一次」标记。
     *
     * 后台状态下 resume 不该硬撑（见 resumePlayback 里的判断），可用户那一下是按过的，
     * 不该就这么丢掉 —— 留个标记，等页面重新可见时补发。
     */
    const pendingForegroundResumeRef = useRef(false);
    useEffect(() => () => {
        transportRevision.current++;
        wantsPlayback.current = false;
        pendingForegroundResumeRef.current = false;
    }, []);

    const resumePlayback = useCallback(async () => {
        if (isNowPlayingStageActive) {
            return;
        }
        const revision = ++transportRevision.current;
        wantsPlayback.current = true;
        // 这一次是明确的播放意图，之前排队的「回到前台补一次」就不必再发。
        pendingForegroundResumeRef.current = false;

        if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
            const currentSyntheticTime = getSyntheticStageLyricsTime();
            syncStageLyricsClock(currentSyntheticTime, duration, PlayerState.PLAYING, stageLyricsClockRef.current.startTimeSec);
            currentTime.set(currentSyntheticTime);
            setPlayerState(PlayerState.PLAYING);
            return;
        }

        // A pause still fading out never reached the element, so there is nothing to start: turn
        // the fade around from the current gain instead of pressing play. A deck the export
        // controller already paused by hand takes the normal path below, which also retires the
        // pending pause.
        if (
            playbackFade.isFadingOut()
            && (!audioRef.current?.paused || isTransitionAudible?.())
            && playbackFade.cancelPendingPause()
        ) {
            setPlayerState(PlayerState.PLAYING);
            return;
        }

        const audio = audioRef.current;
        if (!audio) {
            return;
        }
        // A pause does not cancel source loading, but it must cancel an older
        // asynchronous resume. Store notifications alone cannot identify that
        // stale PLAYING event once a caller has already observed PAUSED.
        const source = usePlaybackStore.getState().audioSrc;
        const isSameSource = () => audioRef.current === audio && usePlaybackStore.getState().audioSrc === source;
        const isCurrent = () => revision === transportRevision.current && isSameSource();
        // A pending refresh can still supply the source after a pause. Its autoplay
        // decision follows the latest transport intent, including a later resume.
        const shouldAutoplay = () => wantsPlayback.current && isSameSource();

        // 原生播放（P1）：下面这一整段（等音频上下文 resume、按 TTL 换在线地址、淡入淡出）
        // 都是围着 Web 音频图转的，原生播放器不挂在那张图上，也用不着这些 —— 它自己管
        // 解码与缓冲。这里是唯一该走的分岔，且必须在碰到元素之前。
        if (nativeTakesRef?.current) {
            syncOutputGain(getTargetPlaybackVolume(), 0);
            try {
                await nativePlaybackEngine.play();
                if (!isCurrent()) return;
                setPlayerState(PlayerState.PLAYING);
            } catch (error) {
                if (!isCurrent()) return;
                setStatusMsg(prev => (prev?.persistent ? prev : { type: 'error', text: t('status.playbackError') }));
                setPlayerState(PlayerState.PAUSED);
                throw error;
            }
            return;
        }

        setupAudioAnalyzer();
        // 后台和前台能做的事不一样：下面两处都要看它（换地址、等 ctx.resume）。
        const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        /*
         * 上下文被挂起就要 resume，但**在后台不能等它**。
         *
         * 这个 Promise 不保证推进（与 `audioWorklet.addModule()` 落在 suspended 的 context 上
         * 是同一类问题）：原来直接 await 它，整条 resume 就卡在这一行 —— 没有声音、
         * 状态机也没动，而原生那边已经在 onPlay 里把歌词锚点切成在播了。
         *
         * ⚠️ 也不能用 `Promise.race(resume, setTimeout)` 去给它限时：**这个应用退到后台后
         * JS 定时器会被系统挂起**（壁纸歌词正是因为这一点才改成「本地锚点 + 墙钟」，见
         * `FoliaPlaybackService.onPlay` 那条注释）。后台里那个计时器自己也不会按时跑，
         * 于是 race 变成换个地方继续卡 —— 和原来一样，只是更难看出是卡在哪。
         *
         * 所以：前台可以等（计时器正常）；后台只发起、不等待，并按**此刻的真实状态**决定。
         */
        const context = audioContextRef.current;
        if (context && context.state === 'suspended') {
            if (isHidden) {
                // 不等：后台里它落地与否都不该拦住这次 resume。
                void context.resume().catch(() => undefined);
                /*
                 * 上下文还挂着，那播了也没声 —— 元素接的是 `createMediaElementSource`，
                 * 输出整条都走这张音频图，图不跑就是静音（见 services/automix/crossfadeGraph）。
                 * 这时候硬播只会是「有进度没声音」：状态机显示 PLAYING、歌词也在走，
                 * 可一点声音都没有。所以先留在暂停（原生那边等不到 playing 会把歌词冻回去），
                 * 回到前台再补一次（见文件末尾的 visibilitychange）。
                 */
                console.warn('[Transport] resume held back: the audio context is suspended while hidden');
                pendingForegroundResumeRef.current = true;
                setPlayerState(PlayerState.PAUSED);
                return;
            }
            try {
                await Promise.race([
                    context.resume(),
                    new Promise<void>(resolve => {
                        setTimeout(resolve, AUDIO_CONTEXT_RESUME_GRACE_MS);
                    }),
                ]);
            } catch {
                // resume 被拒（音频焦点在别的应用手上）不是「不能播」的理由：下面照旧试。
            }
            if (!isCurrent()) return;
        }
        if (!isCurrent()) return;

        syncOutputGain(getTargetPlaybackVolume(), 0);
        // A failed refresh of an address that ran out still falls back to the old one below, as before.
        // Its reason is kept so that, should that play fail too, the message names it.
        let refreshFailure: OnlineFailure | undefined;
        /*
         * 「在线地址过期」要不要先换再播，看是不是在后台。
         *
         * 这是**长时间暂停之后按播放**特有的那一步：`ONLINE_AUDIO_URL_TTL_MS` 一过
         * （20 分钟，见 App.tsx），resume 就得先联网换一次地址才播。而这一步在后台是
         * 一次没有上限的等待 —— 网络慢、或者它走的那条原生桥被占住时，整条 resume
         * 就停在这儿，用户看到的就是「按了播放没反应，打开应用才瞬间恢复」。
         *
         * 后台：直接拿现有地址播。多数平台的地址实际能撑得比 20 分钟久，就算不行，
         * play() 会失败，下面那个 catch 本来就会换一次地址再试 —— 那一步在前台也躲不掉，
         * 但在后台「先出声」远比「先保证地址新鲜」重要（而且 JS 这边根本没有一个
         * 可靠的钟可以给那次联网限时，见上面 ctx.resume 那条注释）。
         * 前台：照旧先换地址，免得播到一半才发现地址失效。
         */
        if (!isHidden && shouldRefreshCurrentOnlineAudioSource()) {
            const refreshed = await recoverOnlinePlaybackSource({
                failedSrc: audio.currentSrc || audioSrc,
                resumeAt: audio.currentTime,
                autoplay: true,
                shouldAutoplay,
            });

            if (!isCurrent() || refreshed.recovered || refreshed.stale) {
                return;
            }
            refreshFailure = refreshed.failure;
        }

        // Silent first, ramped up once play() has really started. Null when the fade is off or
        // there is no Web Audio graph, and the two calls below are then no-ops. Only for an element
        // that is actually stopped: pressing play on one that is already sounding must not dip it.
        const fadeToken = audio.paused || audio.ended
            ? playbackFade.prepareFadeIn()
            : null;
        try {
            await audio.play();
            if (!isCurrent()) { playbackFade.abortFadeIn(fadeToken); return; }
            playbackFade.runFadeIn(fadeToken);
            setPlayerState(PlayerState.PLAYING);
        } catch (error) {
            playbackFade.abortFadeIn(fadeToken);
            if (!isCurrent()) return;
            const recovery = await recoverOnlinePlaybackSource({
                failedSrc: audio.currentSrc || audioSrc,
                resumeAt: audio.currentTime,
                autoplay: true,
                shouldAutoplay,
            });

            if (!isCurrent() || recovery.recovered || recovery.stale) {
                return;
            }

            if (!audio.paused && !audio.ended) {
                setPlayerState(PlayerState.PLAYING);
                return;
            }

            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                setStatusMsg({ type: 'info', text: t('status.clickToPlay') });
                setPlayerState(PlayerState.PAUSED);
                return;
            }

            // An online song whose address was asked for again and refused says why; so does one whose
            // address ran out and could not be had again, where the old one failed to play too. A toast
            // that stays (a countdown to the next song) is not covered by this one.
            const shown = recovery.failure ?? refreshFailure;
            const said = shown ? onlineFailureToast(shown, t) : { type: 'error' as const, text: t('status.playbackError') };
            setStatusMsg(prev => (prev?.persistent ? prev : said));
            setPlayerState(PlayerState.PAUSED);
            throw error;
        }
    }, [activePlaybackContext, audioContextRef, audioRef, audioSrc, currentTime, duration, getSyntheticStageLyricsTime, getTargetPlaybackVolume, isNowPlayingStageActive, isTransitionAudible, nativeTakesRef, recoverOnlinePlaybackSource, setPlayerState, setStatusMsg, setupAudioAnalyzer, shouldRefreshCurrentOnlineAudioSource, stageActiveEntryKind, stageLyricsClockRef, syncOutputGain, syncStageLyricsClock, t]);

    const pausePlayback = useCallback(() => {
        if (isNowPlayingStageActive) {
            return;
        }
        transportRevision.current++;
        wantsPlayback.current = false;
        // 用户自己按了暂停，那一下排队的补播就该作废。
        pendingForegroundResumeRef.current = false;

        if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
            const currentSyntheticTime = getSyntheticStageLyricsTime();
            syncStageLyricsClock(currentSyntheticTime, duration, PlayerState.PAUSED, stageLyricsClockRef.current.startTimeSec);
            currentTime.set(currentSyntheticTime);
            setPlayerState(PlayerState.PAUSED);
            return;
        }

        // 原生播放（P1）：淡出是 Web 音频图上的节点，原生不挂在那张图上，直接停。
        if (nativeTakesRef?.current) {
            void nativePlaybackEngine.pause();
            setPlayerState(PlayerState.PAUSED);
            return;
        }

        const readCurrentSongKey = () => {
            const song = usePlaybackStore.getState().currentSong;
            return song ? getPlaybackSongKey(song) : null;
        };
        const songKeyAtPress = readCurrentSongKey();

        // Before the element is touched, because mid-blend `audioRef` is the wrong element to touch:
        // it names the deck the next track is arriving on. The cancel pauses the deck that is
        // actually sounding, so there is nothing left here but to settle the transport.
        // Returns whether a pause happened, so the caller knows to settle the transport.
        const settlePause = (reason: PlaybackFadeSettleReason = 'elapsed'): boolean => {
            if (pauseDuringTransition?.()) {
                // The cancel left the audio ref on the deck it just paused, and that deck's pause
                // event is as much a flush's as the plain path's below.
                if (reason === 'flushed' && audioRef.current) {
                    markProgrammaticPause(audioRef.current);
                }
                syncOutputGain(getTargetPlaybackVolume(), 0);
                return true;
            }

            if (!audioRef.current) {
                return false;
            }

            // A flush happens while a track change is in flight: its pause event arrives after the
            // new song has set its play intent, so it is marked and ignored by the pause handler.
            if (reason === 'flushed' && !audioRef.current.paused && !audioRef.current.ended) {
                markProgrammaticPause(audioRef.current);
            }
            audioRef.current.pause();
            syncOutputGain(getTargetPlaybackVolume(), 0);
            return true;
        };

        // Fade first, pause when the ramp is done. The whole of settlePause is deferred, so a
        // blend that is armed or running at that moment is still cancelled onto the right deck.
        // The transport reads PAUSED straight away; the element follows ~200ms later. Nothing to
        // fade (already paused, feature off, no Web Audio) pauses directly as before.
        const transitionAtPress = Boolean(isTransitionAudible?.());
        const isSounding = Boolean(audioRef.current && !audioRef.current.paused) || transitionAtPress;
        // Backstop for song changes that bypass playSong's own flush: a different song by the time
        // the fade ends means the pause was meant for the old one, and the new one must keep playing.
        // Not applied during a blend: an armed blend has already asked for the next song, so
        // `currentSong` moves to it a moment after the press without that being a change of mind -
        // and the pause still has to cancel the blend back onto the song the listener was hearing.
        const settleDeferredPause = (reason: PlaybackFadeSettleReason) => {
            const duringBlend = transitionAtPress || Boolean(isTransitionAudible?.());
            if (!duringBlend && readCurrentSongKey() !== songKeyAtPress) return;
            settlePause(reason);
        };
        if (isSounding && playbackFade.fadeOutThen(settleDeferredPause)) {
            setPlayerState(PlayerState.PAUSED);
            return;
        }

        if (settlePause()) {
            setPlayerState(PlayerState.PAUSED);
        }
    }, [activePlaybackContext, audioRef, audioSrc, currentTime, duration, getSyntheticStageLyricsTime, getTargetPlaybackVolume, isNowPlayingStageActive, isTransitionAudible, nativeTakesRef, pauseDuringTransition, setPlayerState, stageActiveEntryKind, stageLyricsClockRef, syncOutputGain, syncStageLyricsClock]);

    /*
     * 回到前台补一次。
     *
     * 在后台按播放时音频上下文不一定能被唤醒（页面被挂起、音频焦点在别处），resumePlayback
     * 那时只留下标记、状态停在暂停 —— 为的是不出现「元素在走、声音没有」的假播放。
     * 页面重新可见（真的有人在看、系统也把页面放回来了）就把那一下补上。
     * 标记在 resumePlayback 一开始就会被清掉，所以在里面再设一次也自洽。
     */
    useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (!pendingForegroundResumeRef.current) return;
            pendingForegroundResumeRef.current = false;
            void resumePlayback();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [resumePlayback]);

    return {
        resumePlayback,
        pausePlayback,
    };
}
