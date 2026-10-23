import { OnlineProviderError } from '../../../types/onlineMusic';
import type { OnlineFailureDetail, OnlineFailureOperation } from '../../../types/onlineMusic';

// src/services/onlineMusic/spotify/spotifyFailure.ts
// What a Spotify request for a song's audio or a collection's tracks that failed hands to the
// shared rules (services/onlineMusic/failure/). What the desktop side's words for a failure mean is
// said here only (they are made in electron/spotify/). A network that fails and 5xx come as
// `network` and need nothing here.

// electron/spotify/errors.cjs gives Spotify's 429 this sentence, under the code of a network that fails.
const ASKED_TO_WAIT = 'Spotify asked to wait before trying again';

/**
 * 安卓上（spotifyInPageRuntime）429 是另一句话：`Spotify answered 429`。所以**按读出来的
 * HTTP 状态认，不按那句英文认** —— 认句子的话，安卓这一路撞上限流会落到「连不上」，
 * 界面也就不会说「稍后再试」。平台要求等多久（`Retry-After`）一并交出去。
 */
export const describeSpotifyFailure = (_operation: OnlineFailureOperation, error: unknown): OnlineFailureDetail | null => {
    if (!(error instanceof OnlineProviderError) || error.providerId !== 'spotify' || error.code !== 'network') return null;
    const saidToWait = error.message === ASKED_TO_WAIT || error.httpStatus === 429;
    if (!saidToWait) return null;
    return {
        case: 'retry-later',
        httpStatus: 429,
        ...(typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
    };
};
