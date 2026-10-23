import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/ytmInPageData.test.ts
// The in-page data operations on Android: youtubei.js's answers must reach the
// provider in the wire shapes the desktop bridge answers in ({ items,
// continuation? } and friends). Returning the library's raw answer instead made
// every search come back empty on a real device (0.7.22.5), because the
// provider reads `page.items` off whatever the operation returns. The fixtures
// below are shaped like youtubei.js 18.1.0's parsed output (and the raw browse
// JSON where the desktop reads raw JSON), so a converter that drifts from the
// library's real shapes fails here first.

const fakeLib = vi.hoisted(() => {
    class MusicPlaylistShelf {}
    class PlaylistPanelVideo {}
    class MusicTwoRowItem {}
    return {
        nodes: { MusicPlaylistShelf, PlaylistPanelVideo, MusicTwoRowItem },
    };
});

const mocks = vi.hoisted(() => ({
    signIn: vi.fn(),
    innertubeCreate: vi.fn(),
    parseResponse: vi.fn(),
    fetch: vi.fn(),
}));

vi.mock('@/services/onlineMusic/ytm/ytmNative', () => ({
    requestYtmNativeSignIn: mocks.signIn,
}));

vi.mock('youtubei.js/web', () => ({
    Innertube: { create: mocks.innertubeCreate },
    Parser: { parseResponse: mocks.parseResponse },
    YTNodes: fakeLib.nodes,
    Constants: { CLIENTS: { YTMUSIC: { NAME: 'WEB_REMIX', VERSION: '1.20260101.01.00' } } },
}));

// A Text instance of the library, as the converters see it: String() is its text.
const text = (value: string, runs?: unknown[]) => ({
    text: value,
    runs: runs ?? [{ text: value }],
    toString() { return value; },
});

const ARTIST_ID = 'UC8CU5nVhCQIdAGrFFp4loYQ';
const artistRun = (name: string) => ({
    text: name,
    endpoint: {
        name: 'browseEndpoint',
        payload: {
            browseId: ARTIST_ID,
            browseEndpointContextSupportedConfigs: {
                browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' },
            },
        },
    },
});

const squareThumb = (base: string, width: number) => ({ url: `${base}=w${width}-h${width}`, width, height: width });

// A song row as MusicResponsiveListItem parses it.
const songRow = (overrides: Record<string, unknown> = {}) => ({
    type: 'MusicResponsiveListItem',
    id: 'dQw4w9WgXcQ',
    title: '晴天',
    artists: [{ name: '周杰伦', channel_id: ARTIST_ID }],
    album: { id: 'MPREb_9Kn', name: '叶惠美' },
    duration: { text: '4:29', seconds: 269 },
    thumbnail: { contents: [squareThumb('https://lh3.googleusercontent.com/x', 60), squareThumb('https://lh3.googleusercontent.com/x', 120)] },
    ...overrides,
});

const wireSong = {
    id: 'dQw4w9WgXcQ',
    name: '晴天',
    artists: [{ id: ARTIST_ID, name: '周杰伦' }],
    album: { id: 'MPREb_9Kn', name: '叶惠美', coverUrl: 'https://lh3.googleusercontent.com/x=w544-h544' },
    durationMs: 269000,
};

const loadRuntime = async () => {
    vi.resetModules();
    return import('@/services/onlineMusic/ytm/ytmInPageRuntime');
};

describe('ytm in-page data operations', () => {
    const yt = {
        music: { search: vi.fn(), getAlbum: vi.fn(), getArtist: vi.fn(), getHomeFeed: vi.fn() },
        actions: { execute: vi.fn() },
        account: { getInfo: vi.fn() },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.signIn.mockResolvedValue({ ok: true, session: { cookie: 'SAPISID=secret', userAgent: 'UA' } });
        mocks.innertubeCreate.mockResolvedValue(yt);
    });

    const signIn = async (runtime: Awaited<ReturnType<typeof loadRuntime>>) => {
        await runtime.signInYtmInPage();
    };

    it('search_songs takes the MusicShelf out of the search and converts its rows', async () => {
        yt.music.search.mockResolvedValue({
            contents: [
                { type: 'MusicCardShelf', contents: [{ type: 'MusicTwoRowItem' }] },
                {
                    type: 'MusicShelf', continuation: 'TOK1',
                    contents: [
                        songRow(),
                        songRow({ id: 'short', title: '坏行' }),
                        songRow({
                            id: 'abc12345678', title: '以父之名', artists: undefined,
                            authors: [{ name: '周杰伦', channel_id: ARTIST_ID }], album: undefined,
                        }),
                    ],
                },
                { type: 'ItemSection', contents: [] },
            ],
        });
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('search_songs', { query: ' 晴天 ' });
        expect(yt.music.search).toHaveBeenCalledWith('晴天', { type: 'song' });
        expect(answer).toEqual({
            items: [
                wireSong,
                { ...wireSong, id: 'abc12345678', name: '以父之名', album: { id: '', name: '', coverUrl: wireSong.album.coverUrl } },
            ],
            continuation: 'TOK1',
        });
    });

    it('search_songs answers an empty page when the answer holds no MusicShelf', async () => {
        yt.music.search.mockResolvedValue({ contents: [{ type: 'MusicCardShelf', contents: [] }] });
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('search_songs', { query: '不存在的歌' })).resolves.toEqual({ items: [] });
    });

    it('search_songs walks a continuation through /search and keeps the next token', async () => {
        yt.actions.execute.mockResolvedValue({
            continuation_contents: { type: 'MusicShelfContinuation', contents: [songRow()], continuation: 'TOK2' },
        });
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('search_songs', { query: '晴天', continuation: 'TOK1' });
        expect(yt.actions.execute).toHaveBeenCalledWith('/search', { continuation: 'TOK1', client: 'YTMUSIC', parse: true });
        expect(answer).toEqual({ items: [wireSong], continuation: 'TOK2' });

        yt.actions.execute.mockResolvedValue({
            continuation_contents: { type: 'MusicShelfContinuation', contents: [songRow()], continuation: null },
        });
        await expect(runtime.runYtmInPage('search_songs', { query: '晴天', continuation: 'TOK2' }))
            .resolves.toEqual({ items: [wireSong] });
    });

    it('search_songs lets a failure surface (and logs it) instead of answering empty', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        yt.music.search.mockRejectedValue(new Error('network gone'));
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('search_songs', { query: '晴天' })).rejects.toThrow('network gone');
        expect(warn.mock.calls.some(call => String(call[0]).includes('[Ytm] search_songs failed'))).toBe(true);
        warn.mockRestore();
    });

    it('album converts the page header and its tracks', async () => {
        yt.music.getAlbum.mockResolvedValue({
            url: 'https://music.youtube.com/playlist?list=OLAK5uy_abc',
            header: {
                title: text('叶惠美'),
                thumbnail: { contents: [squareThumb('https://lh3.googleusercontent.com/a', 226)] },
                strapline_text_one: text('周杰伦', [artistRun('周杰伦')]),
                subtitle: text('2003'),
                description: { description: text('专辑简介') },
            },
            contents: [songRow({ artists: undefined, authors: undefined, album: undefined })],
        });
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('album', { id: 'MPREb_9Kn' });
        expect(answer).toEqual({
            collection: {
                id: 'MPREb_9Kn', type: 'album', name: '叶惠美',
                coverUrl: 'https://lh3.googleusercontent.com/a=w544-h544',
                artists: [{ id: ARTIST_ID, name: '周杰伦' }],
                trackCount: 1, description: '专辑简介', playlistId: 'OLAK5uy_abc',
                publishedAt: Date.UTC(2003, 0, 1),
            },
            // The track row carries its own art, which the converter prefers over the
            // header's (the context cover only fills a row that has none).
            items: [{ ...wireSong, album: { id: 'MPREb_9Kn', name: '叶惠美', coverUrl: 'https://lh3.googleusercontent.com/x=w544-h544' } }],
        });
    });

    it('artist converts the header, the top songs and the album carousel', async () => {
        yt.music.getArtist.mockResolvedValue({
            header: {
                title: text('周杰伦'),
                thumbnail: { contents: [squareThumb('https://lh3.googleusercontent.com/h', 540)] },
                description: text('歌手简介'),
            },
            sections: [
                { type: 'MusicShelf', contents: [songRow({ artists: undefined, authors: undefined })] },
                {
                    type: 'MusicCarouselShelf', header: null,
                    contents: [{
                        type: 'MusicTwoRowItem', item_type: 'album', id: 'MPREb_9Kn',
                        title: text('叶惠美'), thumbnail: [squareThumb('https://lh3.googleusercontent.com/b', 540)],
                        artists: [{ name: '周杰伦', channel_id: ARTIST_ID }], year: '2003',
                    }],
                },
            ],
        });
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('artist', { id: ARTIST_ID });
        expect(answer).toEqual({
            collection: {
                id: ARTIST_ID, type: 'artist', name: '周杰伦',
                coverUrl: 'https://lh3.googleusercontent.com/h=w544-h544', description: '歌手简介',
            },
            songs: [wireSong],
            albums: [{
                id: 'MPREb_9Kn', type: 'album', name: '叶惠美',
                coverUrl: 'https://lh3.googleusercontent.com/b=w544-h544',
                artists: [{ id: ARTIST_ID, name: '周杰伦' }], publishedAt: Date.UTC(2003, 0, 1),
            }],
        });
    });

    // The account playlist read: raw browse JSON (rows, header count) plus the parsed
    // page the library makes of it; the two must land on the same songs.
    const accountRaw = (mark: string) => ({
        responseContext: {
            serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'logged_in', value: mark }] }],
        },
        contents: {
            singleColumnBrowseResultsRenderer: {
                tabs: [{
                    tabRenderer: {
                        content: {
                            sectionListRenderer: {
                                contents: [
                                    { musicResponsiveHeaderRenderer: { secondSubtitle: { runs: [{ text: '12 首歌曲' }] } } },
                                    {
                                        musicPlaylistShelfRenderer: {
                                            contents: [
                                                { musicResponsiveListItemRenderer: { playlistItemData: { videoId: 'dQw4w9WgXcQ', playlistSetVideoId: 'SETVID1' } } },
                                                { musicResponsiveListItemRenderer: { playlistItemData: { videoId: 'abc12345678' } } },
                                            ],
                                        },
                                    },
                                ],
                            },
                        },
                    },
                }],
            },
        },
    });

    const parsedShelfPage = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
        contents_memo: {
            getType: (cls: unknown) => (cls === fakeLib.nodes.MusicPlaylistShelf
                ? [{ type: 'MusicPlaylistShelf', contents: rows, continuation: undefined }]
                : []),
        },
        ...extra,
    });

    it('playlist reads as the account: row ids and the header count land on the songs', async () => {
        yt.actions.execute.mockResolvedValue({ data: accountRaw('1') });
        mocks.parseResponse.mockReturnValue(parsedShelfPage([
            songRow(),
            songRow({ id: 'abc12345678', title: '以父之名' }),
        ]));
        const runtime = await loadRuntime();
        await signIn(runtime);
        const answer = await runtime.runYtmInPage('playlist', { id: 'PL123abc' });
        expect(yt.actions.execute).toHaveBeenCalledWith('/browse', { browseId: 'VLPL123abc', client: 'YTMUSIC', parse: false });
        expect(answer).toEqual({
            items: [{ ...wireSong, setVideoId: 'SETVID1' }, { ...wireSong, id: 'abc12345678', name: '以父之名' }],
            trackCount: 12,
        });
    });

    it('playlist refuses an answer given as to a guest instead of answering an empty list', async () => {
        yt.actions.execute.mockResolvedValue({ data: accountRaw('0') });
        const runtime = await loadRuntime();
        await signIn(runtime);
        await expect(runtime.runYtmInPage('playlist', { id: 'PL123abc' })).rejects.toThrow(/guest/);
    });

    it('playlist needs a sign-in', async () => {
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('playlist', { id: 'PL123abc' })).rejects.toThrow(/sign-in/);
        expect(yt.actions.execute).not.toHaveBeenCalled();
    });

    it('public_playlist reads the parsed page and follows its continuation row', async () => {
        const runtime = await loadRuntime();
        yt.actions.execute.mockResolvedValueOnce(parsedShelfPage([
            songRow(),
            { type: 'ContinuationItem', endpoint: { payload: { token: 'NXT' } } },
        ]));
        const first = await runtime.runYtmInPage('public_playlist', { id: 'PL123abc' });
        expect(yt.actions.execute).toHaveBeenCalledWith('/browse', { browseId: 'VLPL123abc', client: 'YTMUSIC', parse: true });
        expect(first).toEqual({ items: [wireSong], continuation: 'NXT' });

        yt.actions.execute.mockResolvedValueOnce(parsedShelfPage([], {
            contents_memo: { getType: () => [] },
            on_response_received_actions: [{
                type: 'AppendContinuationItemsAction',
                contents: [songRow({ id: 'abc12345678', title: '以父之名' })],
            }],
        }));
        const second = await runtime.runYtmInPage('public_playlist', { id: 'PL123abc', continuation: 'NXT' });
        expect(second).toEqual({ items: [{ ...wireSong, id: 'abc12345678', name: '以父之名' }] });
    });

    // The library tabs as raw browse JSON: one grid holding an album card, a playlist
    // card and the "new playlist" card, which is no collection at all.
    const libraryRaw = () => ({
        responseContext: {
            serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'logged_in', value: '1' }] }],
        },
        contents: {
            singleColumnBrowseResultsRenderer: {
                tabs: [{
                    tabRenderer: {
                        content: {
                            sectionListRenderer: {
                                contents: [{
                                    itemSectionRenderer: {
                                        contents: [{
                                            gridRenderer: {
                                                items: [
                                                    {
                                                        musicTwoRowItemRenderer: {
                                                            title: { runs: [{ text: '叶惠美' }] },
                                                            subtitle: {
                                                                runs: [
                                                                    { text: '周杰伦', navigationEndpoint: { browseEndpoint: { browseId: ARTIST_ID } } },
                                                                    { text: ' • ' }, { text: '专辑' }, { text: ' • ' }, { text: '2003' },
                                                                ],
                                                            },
                                                            thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [squareThumb('https://lh3.googleusercontent.com/c', 540)] } } },
                                                            thumbnailOverlay: {
                                                                musicItemThumbnailOverlayRenderer: {
                                                                    content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchPlaylistEndpoint: { playlistId: 'OLAK5uy_abc' } } } },
                                                                },
                                                            },
                                                            navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_9Kn' } },
                                                        },
                                                    },
                                                    {
                                                        musicTwoRowItemRenderer: {
                                                            title: { runs: [{ text: '深夜歌单' }] },
                                                            subtitle: { runs: [{ text: '播放列表' }, { text: ' • ' }, { text: '3 首歌曲' }] },
                                                            thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [squareThumb('https://lh3.googleusercontent.com/p', 540)] } } },
                                                            navigationEndpoint: { browseEndpoint: { browseId: 'VLMYLIST99' } },
                                                            menu: { menuRenderer: { items: [{ serviceEndpoint: { playlistEditorEndpoint: {} } }] } },
                                                        },
                                                    },
                                                    {
                                                        musicTwoRowItemRenderer: {
                                                            title: { runs: [{ text: '新建歌单' }] },
                                                            subtitle: { runs: [{ text: '' }] },
                                                        },
                                                    },
                                                ],
                                                continuations: [{ nextContinuationData: { continuation: 'GRIDTOK' } }],
                                            },
                                        }],
                                    },
                                    },
                                ],
                            },
                        },
                    },
                }],
            },
        },
    });

    it('user_playlists keeps only the playlist cards of the tab grid', async () => {
        yt.actions.execute.mockResolvedValue({ data: libraryRaw() });
        const runtime = await loadRuntime();
        await signIn(runtime);
        const answer = await runtime.runYtmInPage('user_playlists', {});
        expect(yt.actions.execute).toHaveBeenCalledWith('/browse', { browseId: 'FEmusic_liked_playlists', client: 'YTMUSIC', parse: false });
        expect(answer).toEqual({
            items: [{
                id: 'MYLIST99', type: 'playlist', name: '深夜歌单',
                coverUrl: 'https://lh3.googleusercontent.com/p=w544-h544',
                trackCount: 3, isOwned: true,
            }],
            continuation: 'GRIDTOK',
        });
    });

    it('user_albums keeps only the album cards, with their list id and year', async () => {
        yt.actions.execute.mockResolvedValue({ data: libraryRaw() });
        const runtime = await loadRuntime();
        await signIn(runtime);
        const answer = await runtime.runYtmInPage('user_albums', { continuation: 'GRIDTOK' });
        expect(yt.actions.execute).toHaveBeenCalledWith('/browse', { continuation: 'GRIDTOK', client: 'YTMUSIC', parse: false });
        expect(answer).toEqual({
            items: [{
                id: 'MPREb_9Kn', type: 'album', name: '叶惠美',
                coverUrl: 'https://lh3.googleusercontent.com/c=w544-h544',
                playlistId: 'OLAK5uy_abc', artists: [{ id: ARTIST_ID, name: '周杰伦' }], year: 2003,
            }],
            continuation: 'GRIDTOK',
        });
    });

    it('user_playlists needs a sign-in', async () => {
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('user_playlists', {})).rejects.toThrow(/sign-in/);
    });

    const watchRawWithLyricsTab = (withLyrics: boolean) => ({
        contents: {
            singleColumnMusicWatchNextResultsRenderer: {
                tabbedRenderer: {
                    watchNextTabbedResultsRenderer: {
                        tabs: withLyrics ? [{
                            tabRenderer: {
                                endpoint: {
                                    browseEndpoint: {
                                        browseId: 'MPLYt_x',
                                        browseEndpointContextSupportedConfigs: {
                                            browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' },
                                        },
                                    },
                                },
                            },
                        }] : [],
                    },
                },
            },
        },
    });

    it('lyrics reads the watch page for the lyrics tab and times the lines as LRC', async () => {
        yt.actions.execute.mockResolvedValue({ data: watchRawWithLyricsTab(true) });
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                contents: {
                    elementRenderer: {
                        newElement: {
                            type: {
                                componentType: {
                                    model: {
                                        timedLyricsModel: {
                                            lyricsData: {
                                                timedLyricsData: [
                                                    { lyricLine: '第一行', cueRange: { startTimeMilliseconds: '1000' } },
                                                    { lyricLine: '♪', cueRange: { startTimeMilliseconds: '3000' } },
                                                    { lyricLine: '第二 行', cueRange: { startTimeMilliseconds: '65000' } },
                                                ],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
        });
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('lyrics', { id: 'dQw4w9WgXcQ' });
        expect(answer).toEqual({ mainText: '[00:01.000]第一行\n[01:05.000]第二 行' });
        const fetchCall = mocks.fetch.mock.calls[0] as unknown as [string, { body: string }];
        expect(fetchCall[0]).toBe('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false');
        expect(JSON.parse(fetchCall[1].body)).toEqual({
            context: { client: { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50' } },
            browseId: 'MPLYt_x',
        });
    });

    it('lyrics answers null when the track has no lyrics tab', async () => {
        yt.actions.execute.mockResolvedValue({ data: watchRawWithLyricsTab(false) });
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('lyrics', { id: 'dQw4w9WgXcQ' })).resolves.toBeNull();
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    const watchPageWithEntries = (entries: unknown[]) => ({
        contents_memo: {
            getType: (cls: unknown) => (cls === fakeLib.nodes.PlaylistPanelVideo ? entries : []),
        },
    });

    const queueEntry = (overrides: Record<string, unknown> = {}) => ({
        video_id: 'dQw4w9WgXcQ',
        title: text('晴天'),
        artists: [{ name: '周杰伦', channel_id: ARTIST_ID }],
        album: { id: 'MPREb_9Kn', name: '叶惠美' },
        thumbnail: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480, height: 360 }],
        duration: { text: '4:29', seconds: 269 },
        ...overrides,
    });

    it('song_detail takes the asked song out of the watch page queue', async () => {
        yt.actions.execute.mockResolvedValue(watchPageWithEntries([
            queueEntry({ video_id: 'abc12345678', title: text('别的歌') }),
            queueEntry(),
        ]));
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('song_detail', { id: 'dQw4w9WgXcQ' });
        expect(yt.actions.execute).toHaveBeenCalledWith('/next', { videoId: 'dQw4w9WgXcQ', client: 'YTMUSIC', parse: true });
        expect(answer).toEqual({
            ...wireSong,
            album: { id: 'MPREb_9Kn', name: '叶惠美', coverUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' },
        });
    });

    it('song_detail answers null when the watch page does not list the song', async () => {
        yt.actions.execute.mockResolvedValue(watchPageWithEntries([queueEntry({ video_id: 'abc12345678' })]));
        const runtime = await loadRuntime();
        await expect(runtime.runYtmInPage('song_detail', { id: 'dQw4w9WgXcQ' })).resolves.toBeNull();
    });

    it('song_detail_en asks the watch page in English, with the music client named', async () => {
        mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
        mocks.parseResponse.mockReturnValue(watchPageWithEntries([queueEntry()]));
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('song_detail_en', { id: 'dQw4w9WgXcQ' });
        const fetchCall = mocks.fetch.mock.calls[0] as unknown as [string, { body: string }];
        expect(fetchCall[0]).toBe('https://music.youtube.com/youtubei/v1/next?prettyPrint=false');
        expect(JSON.parse(fetchCall[1].body)).toEqual({
            context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20260101.01.00', hl: 'en' } },
            videoId: 'dQw4w9WgXcQ',
        });
        expect((answer as { name: string }).name).toBe('晴天');
    });

    it('mix reads the queue made up for the list id', async () => {
        yt.actions.execute.mockResolvedValue(watchPageWithEntries([
            queueEntry(),
            queueEntry({ video_id: 'abc12345678', title: text('以父之名') }),
        ]));
        const runtime = await loadRuntime();
        const answer = await runtime.runYtmInPage('mix', { id: 'RDAMVMdQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ' });
        expect(yt.actions.execute).toHaveBeenCalledWith('/next', {
            playlistId: 'RDAMVMdQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', client: 'YTMUSIC', parse: true,
        });
        const items = (answer as { items: Array<{ id: string }> }).items;
        expect(items.map(item => item.id)).toEqual(['dQw4w9WgXcQ', 'abc12345678']);
    });

    it('explore converts the home feed shelves and walks its chain by token', async () => {
        const feedTwo = {
            sections: [{
                type: 'MusicCarouselShelf',
                header: { title: text('第二页架') },
                contents: [{
                    type: 'MusicTwoRowItem', item_type: 'song', id: 'abc12345678',
                    title: text('第二页的歌'), subtitle: text('周杰伦', [artistRun('周杰伦')]),
                    thumbnail: [squareThumb('https://lh3.googleusercontent.com/t', 60)],
                    endpoint: { name: 'watchEndpoint', payload: { videoId: 'abc12345678' } },
                }],
            }],
            has_continuation: false,
        };
        yt.music.getHomeFeed.mockResolvedValue({
            sections: [
                {
                    type: 'MusicCarouselShelf',
                    header: { title: text('为你推荐') },
                    contents: [
                        {
                            type: 'MusicTwoRowItem', item_type: 'song', id: 'dQw4w9WgXcQ',
                            title: text('晴天'), subtitle: text('周杰伦', [artistRun('周杰伦')]),
                            thumbnail: [squareThumb('https://lh3.googleusercontent.com/s', 60)],
                            endpoint: { name: 'watchEndpoint', payload: { videoId: 'dQw4w9WgXcQ' } },
                        },
                        {
                            type: 'MusicTwoRowItem', item_type: 'album', id: 'MPREb_9Kn',
                            title: text('叶惠美'), subtitle: text('周杰伦', [artistRun('周杰伦')]),
                            thumbnail: [squareThumb('https://lh3.googleusercontent.com/b', 540)],
                            endpoint: {
                                name: 'browseEndpoint',
                                payload: {
                                    browseId: 'MPREb_9Kn',
                                    browseEndpointContextSupportedConfigs: {
                                        browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' },
                                    },
                                },
                            },
                        },
                    ],
                },
                { type: 'MusicTastebuilderShelf', contents: [] },
                {
                    type: 'MusicCarouselShelf', header: { title: text('空架') },
                    contents: [{ type: 'MusicNavigationButton' }],
                },
            ],
            has_continuation: true,
            getContinuation: vi.fn().mockResolvedValue(feedTwo),
        });
        const runtime = await loadRuntime();
        const first = await runtime.runYtmInPage('explore', {});
        expect(first).toEqual({
            sections: [{
                title: '为你推荐',
                items: [
                    {
                        kind: 'song',
                        song: {
                            id: 'dQw4w9WgXcQ', name: '晴天',
                            artists: [{ id: ARTIST_ID, name: '周杰伦' }],
                            album: { id: '', name: '', coverUrl: 'https://lh3.googleusercontent.com/s=w544-h544' },
                            durationMs: 0,
                        },
                    },
                    {
                        kind: 'collection',
                        collection: {
                            id: 'MPREb_9Kn', type: 'album', name: '叶惠美',
                            coverUrl: 'https://lh3.googleusercontent.com/b=w544-h544',
                            artists: [{ id: ARTIST_ID, name: '周杰伦' }],
                        },
                    },
                ],
            }],
            continuation: 'homefeed-1',
        });
        const second = await runtime.runYtmInPage('explore', { continuation: 'homefeed-1' });
        expect(second).toEqual({
            sections: [{
                title: '第二页架',
                items: [{
                    kind: 'song',
                    song: {
                        id: 'abc12345678', name: '第二页的歌',
                        artists: [{ id: ARTIST_ID, name: '周杰伦' }],
                        album: { id: '', name: '', coverUrl: 'https://lh3.googleusercontent.com/t=w544-h544' },
                        durationMs: 0,
                    },
                }],
            }],
        });
        await expect(runtime.runYtmInPage('explore', { continuation: 'homefeed-99' })).resolves.toEqual({ sections: [] });
    });
});
