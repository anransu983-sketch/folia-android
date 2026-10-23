import type { WallMetrics } from '../../../components/wall/layout';

// src/library/suites/bravais/bravaisConstants.ts
// bravais 的几何与开口常量。wall 引擎只认「开口宽度」这个参数（B5 的决定），开口等级的宽度、窄屏阈值、
// 相机缩放档位这些 bravais 自己的 UI 语义放在这里。数值来自原型（dev/prototypes/bravais/index.html）。

/** 与 Lattice、原型相同的格子：128 的格，8 的缝隙。 */
export const BRAVAIS_METRICS: WallMetrics = { cellSize: 128, gap: 8 };

/** 完整信息条（集合页）的开口。 */
export const BRAVAIS_SEAM_FULL_WIDTH = 300;
/** 首页窄缝（只放页签与入口）的开口。 */
export const BRAVAIS_SEAM_HOME_WIDTH = 120;
/** 书脊。 */
export const BRAVAIS_SEAM_SPINE_WIDTH = 64;
/**
 * 信息条横向（设置「信息条横向」）：缝从块的横向缝隙（块行边界）裂开，墙上下分开。这三个是横条的开口高度，依次对应
 * 完整信息条（与首页的搜索框）、首页窄缝、书脊（首页与集合层同一个高度）。
 */
export const BRAVAIS_SEAM_ROW_FULL_HEIGHT = 212;
export const BRAVAIS_SEAM_ROW_HOME_HEIGHT = 72;
export const BRAVAIS_SEAM_ROW_SPINE_HEIGHT = 52;
/**
 * 歌手页的海报（完整等级下的歌手页缝）：宽度随视口取 46%，夹在这个范围里。海报仍是墙上的开口（与信息条同一层，
 * 从块边界裂开），只是相机把它带到视口最左边、贴边不留距离（bravaisFrame 的 poster）。
 */
export const BRAVAIS_SEAM_POSTER_MIN_WIDTH = 520;
export const BRAVAIS_SEAM_POSTER_MAX_WIDTH = 680;
export const BRAVAIS_SEAM_POSTER_VIEWPORT_RATIO = 0.46;
/** 海报在场时整层（两半墙与缝）倾斜的角度（度，负 = 逆时针），绕海报右缘、视口半高转。 */
export const BRAVAIS_POSTER_TILT_DEG = -10;
/**
 * 倾斜的补间：张开时等裂缝先走一小段（DELAY）再转，转得比开口与相机慢一点，三者一起落定；回正跟着缝合上走。
 * 缓动两头都平（ease-in-out），不是一下子甩过去。
 */
export const BRAVAIS_POSTER_TILT_IN_DELAY_S = 0.12;
export const BRAVAIS_POSTER_TILT_IN_S = 0.95;
export const BRAVAIS_POSTER_TILT_OUT_S = 0.5;
export const BRAVAIS_POSTER_TILT_EASE = [0.45, 0, 0.2, 1] as const;
/** 视口窄于它时默认收成书脊（设计稿 §5 的 NARROW_VW）。 */
export const BRAVAIS_NARROW_VIEWPORT_PX = 900;

/** 视口外多渲染的世界距离（世界单位）；翻牌也只翻这个范围以内的磁贴。 */
export const BRAVAIS_OVERSCAN = 420;
/** 离已渲染范围的边缘还剩这么多（世界单位）时重新裁剪。 */
export const BRAVAIS_CULL_EDGE_MARGIN = 160;
/**
 * 窄屏（手机竖屏，<640）一档的预渲染距离与重裁余量。窄屏的世界可见宽度本来就小（约 660），420 的预渲染
 * 只够半屏多一点，手指一甩就拖出已渲染范围、露出空白，等重裁与入场动画补上又是一阵发白。把预渲染
 * 扩到 1100（约 1.7 屏宽）、重裁余量留到 420：拖动全程边缘始终有货，代价是多渲染几块磁贴
 * （仍远低于 MAX_RENDERED_INSTANCES 的上限）。宽屏两数与原来一模一样。
 */
export const BRAVAIS_OVERSCAN_NARROW = 1100;
export const BRAVAIS_CULL_EDGE_MARGIN_NARROW = 420;
/**
 * 性能模式（usePerformanceSettingsStore，只在安卓生效）下的预渲染与重裁余量：都收小，拖动时
 * 少渲染一圈磁贴换帧率。窄屏 560 约是可见世界宽度（约 660）的 0.85 倍 —— 快速甩动时边缘可能
 * 短暂露白，这是性能模式明码标价的取舍，默认档仍是上面的 1100 / 420。余量必须小于预渲染
 * （相机 padding = 两者之差，要为正），两档都满足。
 */
export const BRAVAIS_OVERSCAN_PERFORMANCE = 280;
export const BRAVAIS_OVERSCAN_NARROW_PERFORMANCE = 560;
export const BRAVAIS_CULL_EDGE_MARGIN_PERFORMANCE = 120;
export const BRAVAIS_CULL_EDGE_MARGIN_NARROW_PERFORMANCE = 200;

/** 缩放分档里窄屏一档的宽度断点，预渲染分档与它对齐。 */
export const BRAVAIS_NARROW_SCALE_PX = 640;

/** 按视口宽度取预渲染距离：窄屏用扩过的一档，其余是原值；性能模式再换成收小的一档。 */
export const getBravaisOverscan = (viewportWidth: number, performanceMode = false) => (
    performanceMode
        ? viewportWidth < BRAVAIS_NARROW_SCALE_PX ? BRAVAIS_OVERSCAN_NARROW_PERFORMANCE : BRAVAIS_OVERSCAN_PERFORMANCE
        : viewportWidth < BRAVAIS_NARROW_SCALE_PX ? BRAVAIS_OVERSCAN_NARROW : BRAVAIS_OVERSCAN
);
/** 按视口宽度取重裁余量：窄屏用扩过的一档，其余是原值；性能模式再换成收小的一档。 */
export const getBravaisCullEdgeMargin = (viewportWidth: number, performanceMode = false) => (
    performanceMode
        ? viewportWidth < BRAVAIS_NARROW_SCALE_PX ? BRAVAIS_CULL_EDGE_MARGIN_NARROW_PERFORMANCE : BRAVAIS_CULL_EDGE_MARGIN_PERFORMANCE
        : viewportWidth < BRAVAIS_NARROW_SCALE_PX ? BRAVAIS_CULL_EDGE_MARGIN_NARROW : BRAVAIS_CULL_EDGE_MARGIN
);

/**
 * 相机缩放档位，与 Lattice 的 PosterWall 相同（<640: .62，<1100: .64，否则 .76）。
 * 窄屏一档原是 .52：真机（S26 Ultra 竖屏）上卡片显得小而散、拖动时大片空场，收到 .62 后一屏的
 * 世界宽度从约 790 降到约 660，卡片更大更密；.64 的中档与它只差 .02，窄屏一屏仍比中档多看到一点。
 */
export const getBravaisScale = (viewportWidth: number) => (
    viewportWidth < BRAVAIS_NARROW_SCALE_PX ? 0.62 : viewportWidth < 1100 ? 0.64 : 0.76
);

/** 缝开合与相机让位的补间时长（秒）。 */
export const BRAVAIS_SEAM_TWEEN_S = 0.36;
export const BRAVAIS_CAMERA_TWEEN_S = 0.42;

/** 缝内容翻转：转到 90° 换内容，再转回来（毫秒）。 */
export const BRAVAIS_SEAM_FLIP_OUT_MS = 160;
export const BRAVAIS_SEAM_FLIP_IN_MS = 240;

/** 磁贴翻牌：前半段转到 90°，后半段转回来；两段合计等于 wall 的 FLIP_DURATION_MS（360）。 */
export const BRAVAIS_TILE_FLIP_OUT_MS = 150;
export const BRAVAIS_TILE_FLIP_IN_MS = 210;
/**
 * 降低动态效果时（B11，bravaisMotion）翻牌换成的淡出 → 换内容 → 淡入：两段合计 0.18s（与宿主中性背景板同一个时长），
 * 所有磁贴同时、不错开；整墙波次（换页签、从搜索 / 播放页进出）也换成它。
 */
export const BRAVAIS_REDUCED_FADE_MS = 180;

/**
 * 专辑海报上封面取的尺寸。专辑墙的拼贴在大图到之前拿同一个尺寸垫着（放大后是糊的），专辑页打开时海报已经在取它，
 * 两边共用一份缓存。
 */
export const BRAVAIS_ALBUM_COVER_PX = 512;

/** 聚焦卡 / 键盘焦点让相机露出一个矩形时保留的屏幕边距。 */
export const BRAVAIS_REVEAL_PAD_PX = 24;
/** 缝内容底部在「播放条安全区」之上再多留的距离（设计稿 §5：底距 + 80 + 8）。 */
export const BRAVAIS_SEAM_SAFE_AREA_EXTRA_PX = 8;
/** 没有播放条时缝内容的底边距。 */
export const BRAVAIS_SEAM_BASE_BOTTOM_PX = 20;

/**
 * 两个透明档下缝的纸条要不要加 backdrop blur（亚克力）。先不加：纸条宽 300px，blur 是一笔随分辨率增长、
 * 每帧都要重算的 GPU 成本，要不要加按 B12 的换机实测决定（plan/bravais-transparency-handoff.md）。
 */
export const BRAVAIS_SEAM_ACRYLIC_BLUR = false;
