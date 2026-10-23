// src/services/onlineMusic/ytm/youtubeiModule.d.ts
//
// youtubei.js 的类型声明只在**装了它**的机器上才有。
//
// 它是 `dependencies` 里的一员（Electron 主进程那套 YTM 桥要用），但只出 Web 包的环境
// （例如只跑 `npm ci --omit=optional`、或某个装不全的开发机）里可以缺席 —— 而
// `import('youtubei.js/web')` 是**字面量** specifier，tsc 会当场就要求它在场，
// 于是「本机少装一个包」被算成主工程的编译错误。
//
// 所以这里只声明我们用得到的那一点（Innertube.create），让主工程与这个包的装没装解耦。
// 声明到这儿就够了：调用侧本来就把它当不透明对象用（`const yt: any`），
// 逐层解析是 youtubei.js 自己的事。
//
// 字面量是必须的（不能换成变量 + @vite-ignore）：那样 vite 就不会把它打进异步分包，
// 运行时浏览器要去解析一个裸 specifier，`import()` 直接失败。

declare module 'youtubei.js/web' {
    export class Innertube {
        static create(options?: Record<string, unknown>): Promise<any>;
    }
}
