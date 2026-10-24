import { beforeAll, describe, expect, it, vi } from 'vitest';

// test/unit/spotify/spotifyInPageIsrc.test.ts
// The Android translation layer (spotifyInPageRuntime) folds the public Web API's track rows
// into the desktop shape. A full track object carries `external_ids.isrc`; the fold must keep
// it (as `isrc`) or Spotube loses its match-cache key. Simplified rows (an album's tracks)
// carry none upstream, and the fold must then leave the slot out.

const TRACK_WITH = 'a'.repeat(22);
const TRACK_WITHOUT = 'b'.repeat(22);
const TRACK_SINGLE = 'c'.repeat(22);

const webTrack = (id: string, isrc?: string) => ({
    id,
    uri: `spotify:track:${id}`,
    name: `Song ${id[0]}`,
    artists: [{ id: 'artist1', uri: 'spotify:artist:artist1', name: 'Artist' }],
    album: { id: 'album1', uri: 'spotify:album:album1', name: 'Album', images: [] },
    duration_ms: 201_000,
    ...(isrc ? { external_ids: { isrc } } : {}),
});

const fakeFetch = vi.fn(async (url: string) => {
    const body = url.includes('/search?')
        ? { tracks: { items: [webTrack(TRACK_WITH, 'USRC10000001'), webTrack(TRACK_WITHOUT)] } }
        : url.includes(`/tracks/${TRACK_SINGLE}`)
            ? webTrack(TRACK_SINGLE, 'USRC10000002')
            : null;
    if (!body) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

vi.mock('@/services/nativeHttpFetch', () => ({
    createNativeFetch: () => fakeFetch,
    isNativeHttpFetchAvailable: () => true,
    NATIVE_HTTP_TIMEOUT_MS: 45_000,
}));
vi.mock('@/services/onlineMusic/spotify/spotifyNative', () => ({
    isSpotifyNativeAvailable: () => true,
    requestSpotifyNativeSignIn: async () => ({ ok: true, session: { accessToken: 'token', refreshToken: 'refresh', expiresInMs: 3_600_000 } }),
    refreshSpotifyNativeSession: async () => ({ ok: false, error: { code: 'unavailable', message: 'not needed in this test' } }),
}));

import { runSpotifyInPage } from '@/services/onlineMusic/spotify/spotifyInPageRuntime';

beforeAll(async () => {
    await runSpotifyInPage('login_start');
});

describe('the folded track shape and isrc', () => {
    it('keeps external_ids.isrc from search rows that carry it, and omits it where they do not', async () => {
        const answer = await runSpotifyInPage('query', { name: 'searchTracks', variables: { searchTerm: 'Song', limit: 2, offset: 0 } }) as {
            searchV2: { tracksV2: { items: Array<{ item: { data: { uri: string; isrc?: string } } }> } };
        };
        const rows = answer.searchV2.tracksV2.items.map(row => row.item.data);
        expect(rows[0].uri).toBe(`spotify:track:${TRACK_WITH}`);
        expect(rows[0].isrc).toBe('USRC10000001');
        expect(rows[1].isrc).toBeUndefined();
    });

    it('keeps it for a track read on its own', async () => {
        const answer = await runSpotifyInPage('query', { name: 'getTrack', variables: { uri: `spotify:track:${TRACK_SINGLE}` } }) as {
            trackUnion: { isrc?: string };
        };
        expect(answer.trackUnion.isrc).toBe('USRC10000002');
    });
});
