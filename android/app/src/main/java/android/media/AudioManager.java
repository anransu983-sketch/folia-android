package android.media;

/*
 * **编译期占位**：只为让 top.izuna.foliamajor.audio.FoliaAudioManager 能继承 AudioManager。
 *
 * android.jar 里那个 AudioManager 没有可见的构造方法 —— 带 Context 的那个被 @hide 掉了，
 * 剩下的无参构造又不是 public。实测直接继承的两种写法都编译不过：
 *   super(context) → 「无法将 AudioManager 中的构造器应用到给定类型；需要：没有参数」
 *   super()        → 「AudioManager() 在 AudioManager 中不是 public；无法从外部程序包访问」
 * 所以放一个同名类把 `AudioManager(Context)` 暴露出来，javac 从 sourcepath 解析继承
 * 关系时用的就是这一份。
 *
 * 运行时**轮不到这份**：android.media 属于 boot classpath，双亲委派下解析到的是系统
 * framework 里真正的 AudioManager，被打进 dex 的这一份永远不会被加载 —— 方法体写成
 * 什么都不影响行为。但**签名必须与真的一致**，否则子类那两个覆写在运行时就只是两个
 * 谁也不认的新方法，拦截形同虚设。
 *
 * 改动真机上 AudioManager 的签名时（升级 compileSdk 后编译报错），同步改这里。
 */
public class AudioManager {

    public AudioManager(android.content.Context context) {
    }

    /** 真机由 framework 提供；这里只为让子类的覆写与 super 调用能通过编译。 */
    public interface OnAudioFocusChangeListener {
        void onAudioFocusChange(int focusChange);
    }

    public int requestAudioFocus(AudioFocusRequest focusRequest) {
        return 0;
    }

    public int requestAudioFocus(OnAudioFocusChangeListener listener, int streamType, int durationHint) {
        return 0;
    }
}
