import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { ensureBackgroundRenderGateInstalled } from './utils/backgroundRenderGate';
import { installNativeAndroidBridge } from './services/nativeAndroidBridge';
import { installAndroidPhoneFitPreference, installDeviceProfilePreference } from './services/androidPhoneLayout';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
installGlobalVisualizerFrameRateLimiter();
// 后台渲染总闸（useBackgroundRenderPause 的底层）：装了不等于暂停，只是让 rAF 过一道闸。
ensureBackgroundRenderGateInstalled();
// 安卓原生桥与手机适配偏好：只在 Capacitor 安卓运行时生效，其他平台为空操作。
installNativeAndroidBridge();
installAndroidPhoneFitPreference();
installDeviceProfilePreference();

void import('./bootstrap');
