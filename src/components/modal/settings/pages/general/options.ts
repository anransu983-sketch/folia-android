import { isCapacitorAndroid } from '../../../../../platform/runtime';
import { option, type SettingsGroupDef } from '../../kit';

// src/components/modal/settings/pages/general/options.ts
// The groups and options of the 通用 page, declared apart from the page so the files that draw its
// rows name the same ones. The 安卓 group's one row is drawn by its own component
// (AndroidScreenAwakeSetting), which is why it is declared here rather than in the page.
//
// `noteKey` carries the row's explanation — kept behind the "i", not printed under the label — and
// is the text the settings search matches it by.

export const LANGUAGE: SettingsGroupDef = { id: 'languageSettings', titleKey: 'options.languageSettings' };
export const LAUNCH: SettingsGroupDef = { id: 'labWindowAndTools', titleKey: 'options.settingsHeadingLaunch' };
export const UPDATE: SettingsGroupDef = { id: 'updateCheck', titleKey: 'options.updateCheck', electronOnly: true };
export const PONDER: SettingsGroupDef = { id: 'ponderHints', titleKey: 'options.ponderHints' };

/**
 * 安卓专有那一项（fork 独有）：屏幕常亮。
 *
 * 显示那几项（毛玻璃 / 歌词扁平 / 设备类型 / 手机适配）搬去了外观页，Lyricon 搬去了
 * 「连接与集成」页 —— 都是「看」的东西，堆在通用页里只是因为以前那里挂的是老式卡片。
 * 整组只有安卓才画（组件自己也判一次运行时），所以靠 `available` 让它在桌面端连同这张
 * 空卡、带这一条搜索结果一起退场。
 */
export const ANDROID: SettingsGroupDef = {
    id: 'androidSettings',
    titleKey: 'options.androidSettings',
    available: isCapacitorAndroid,
};

export const O = {
    language: option(LANGUAGE, 'appLanguage', 'options.appLanguage'),
    autoPlay: option(LAUNCH, 'autoPlayOnLaunch', 'options.autoPlayOnLaunch'),
    /*
     * 起播的同时直接切到歌词页。原来这一行跟在实验室页的「进入应用后自动播放」下面，
     * 上游重构把实验室那页整个摘掉了（文件还在，但已经没人引用它），两行一起从界面上
     * 消失 —— store 与恢复播放那条路都还在，所以只要把行放回启动这一组就行。
     */
    autoJumpToVisualizer: option(LAUNCH, 'autoJumpToVisualizerOnLaunch', 'options.autoJumpToVisualizerOnLaunch'),
    /*
     * 启动后直接进入播放界面。
     *
     * 上游把它挂在「桌面」那一页，后来搬进启动组时把 `electronOnly` 一起带了过来 —— 于是安卓
     * 上整行不画。可这一项跟平台没有关系：开关只写 `open_player_on_launch` 这一个 localStorage
     * 键，启动时 `useAppNavigation` 的 `getStartupView()` 直接读同一个键（也不判平台），
     * 它跟随的「播放后进入的视图」在安卓上同样有入口。所以这里只去掉标记，别的不动。
     */
    openPlayer: option(LAUNCH, 'openPlayerOnLaunch', 'options.openPlayerOnLaunch'),
    titlebarButtons: option(LAUNCH, 'alwaysShowMainWindowTitlebar', 'options.alwaysShowMainWindowTitlebar'),
    updateCheck: option(UPDATE, 'enableUpdateCheck', 'options.enableUpdateCheck'),
    autoUpdate: option(UPDATE, 'enableAutoUpdate', 'options.enableAutoUpdate'),
    updateChannel: option(UPDATE, 'updateChannel', 'options.updateChannel'),
    ponderHints: option(PONDER, 'ponderHintVisibility', 'options.ponderHints'),
    ponderTouchButton: option(PONDER, 'ponderTouchButton', 'options.ponderTouchButton'),
    keepScreenAwake: option(ANDROID, 'keepScreenAwake', 'options.keepScreenAwake', {
        noteKey: 'options.keepScreenAwakeDesc',
        available: isCapacitorAndroid,
    }),
};
