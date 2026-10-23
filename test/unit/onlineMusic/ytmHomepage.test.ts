import { describe, expect, it } from 'vitest';
import { ytmHomepageSignedInOf } from '@/services/onlineMusic/ytm/ytmHomepage';

// test/unit/onlineMusic/ytmHomepage.test.ts
// The homepage is the third witness of a YTM sign-in: fetched with the handed-back
// cookie, the page writes its own verdict into the HTML — ytcfg's LOGGED_IN first,
// the initial data's loggedIn second. No flag in the page means no verdict, never
// a guess in either direction.

describe('ytmHomepageSignedInOf', () => {
    it('reads the ytcfg LOGGED_IN flag when the page says signed in', () => {
        const html = '<script>ytcfg.set({"INNERTUBE_API_KEY":"x","LOGGED_IN":true,"SESSION_INDEX":0});</script>';
        expect(ytmHomepageSignedInOf(html)).toBe(true);
    });

    it('reads the ytcfg LOGGED_IN flag when the page says guest', () => {
        const html = '<script>ytcfg.set({"INNERTUBE_API_KEY":"x","LOGGED_IN":false});</script>';
        expect(ytmHomepageSignedInOf(html)).toBe(false);
    });

    it('tolerates whitespace around the flag value', () => {
        expect(ytmHomepageSignedInOf('"LOGGED_IN": true')).toBe(true);
        expect(ytmHomepageSignedInOf('"LOGGED_IN" : false')).toBe(false);
    });

    it('falls back to the initial data loggedIn flag when ytcfg carries none', () => {
        const html = '<script>var ytInitialData = {"responseContext":{},"loggedIn":true};</script>';
        expect(ytmHomepageSignedInOf(html)).toBe(true);
    });

    it('prefers the ytcfg flag over the data flag when they disagree', () => {
        const html = '"LOGGED_IN":false and elsewhere "loggedIn":true';
        expect(ytmHomepageSignedInOf(html)).toBe(false);
    });

    it('says nothing when the page carries no flag at all', () => {
        expect(ytmHomepageSignedInOf('<html><body>sign in</body></html>')).toBeUndefined();
        expect(ytmHomepageSignedInOf('')).toBeUndefined();
    });
});
