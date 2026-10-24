import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/config';
import { OnlineProviderError } from '@/types/onlineMusic';
import { describeSpotifyFailure } from '@/services/onlineMusic/spotify/spotifyFailure';
import { noteOnlineFailure, onlineFailureOf } from '@/services/onlineMusic/failure/onlineFailureCase';
import { noteOnlineRequestCooldown, onlineRequestCooldown, resetOnlineRequestCooldowns } from '@/services/onlineMusic/failure/onlineRequestCooldown';

// test/unit/onlineMusic/spotubeFailure.test.ts
// 任务 6 的锁，整条走生产路径而不是直调内部函数：spotubeSource 的 no-match 错
// （not-playable + cause 标记）→ describeSpotifyFailure 翻成 no-audio 并带专属文案 →
// onlineFailureOf 折叠 → noteOnlineRequestCooldown 必须忽略它（不冷却、不连累后续点歌）。

const noMatchError = (): OnlineProviderError => new OnlineProviderError(
    'not-playable',
    'No playable match for "Blue Skies".',
    'spotify',
    { spotubeNoMatch: true },
);

describe('describeSpotifyFailure for a spotube no-match', () => {
    it('names the no-audio case and carries the spotube wording, not the generic one', () => {
        const detail = describeSpotifyFailure('audio', noMatchError());
        expect(detail?.case).toBe('no-audio');
        expect(detail?.message).toBe(i18n.t('failure.spotubeNoMatch'));
        expect(detail?.message).toBeTruthy();
        expect(detail?.message).not.toBe(i18n.t('failure.noAudio'));
    });

    it('does not claim an unmarked not-playable error', () => {
        const plain = new OnlineProviderError('not-playable', 'something else', 'spotify');
        expect(describeSpotifyFailure('audio', plain)).toBeNull();
    });

    it('folds to a no-audio failure the request cooldown ignores', () => {
        resetOnlineRequestCooldowns();
        const error = noMatchError();
        noteOnlineFailure(error, describeSpotifyFailure('audio', error));
        const failure = onlineFailureOf({ operation: 'audio', providerId: 'spotify' }, { error });
        expect(failure.case).toBe('no-audio');
        expect(failure.facts.message).toBe(i18n.t('failure.spotubeNoMatch'));
        noteOnlineRequestCooldown(failure);
        expect(onlineRequestCooldown('spotify', 'play')).toBeNull();
        expect(onlineRequestCooldown('spotify', 'prefetch')).toBeNull();
    });
});
