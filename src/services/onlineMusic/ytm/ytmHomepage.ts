// src/services/onlineMusic/ytm/ytmHomepage.ts
//
// 读 music.youtube.com 首页 HTML 里页面自己写的登录结论。
//
// 为什么需要这一路：Innertube 接口的登录靠 SAPISIDHASH 签名，签名被不被服务端
// 认下还受请求来源等因素影响 —— 接口答「游客」只说明接口这条路没认下，不等于
// 交回来的 cookie 是假的。而首页是浏览器自己的读法：带着 cookie 打开页面，页面
// 内嵌的配置直接写了登录没有。这与用户在登录窗里亲眼看到的头像是同一份事实，
// 所以它能做接口两路（getInfo、accounts_list）之外的第三个信号。
// 这里只读 HTML、不发请求（发请求在 ytmInPageRuntime）。

/**
 * 首页 HTML 说登录了没有：true 登录、false 游客、undefined 没写 —— 说不准，
 * 不能拿它判任何一边。先认 ytcfg 里的 LOGGED_IN（页面自己的配置，结论最硬），
 * 没有再退到页面数据里的 loggedIn。
 */
export const ytmHomepageSignedInOf = (html: string): boolean | undefined => {
    const config = /"LOGGED_IN"\s*:\s*(true|false)/.exec(html);
    if (config) return config[1] === 'true';
    const data = /"loggedIn"\s*:\s*(true|false)/.exec(html);
    if (data) return data[1] === 'true';
    return undefined;
};
