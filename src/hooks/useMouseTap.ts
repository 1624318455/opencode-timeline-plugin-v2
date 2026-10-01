/**
 * 鼠标点按双通道封装（macOS 适配）。
 *
 * 背景：OpenTUI 只有 onMouseDown/onMouseUp，没有 onClick。Windows Terminal
 * 默认透传 mouse press，单 onMouseDown 足够；但 macOS 侧常见三种情况收不到 press：
 * Terminal.app 不支持 SGR 鼠标上报；iTerm2/VSCode 集成终端默认吞掉 press；
 * tmux/mosh 等多路复用下 press 被消费、只剩 release。
 * 因此 press（down）为主通道，release（up）为兜底通道：down 立即执行并记时，
 * up 仅在距离上次 down 超过去重窗口时才执行。
 *
 * Windows 行为不变：down+up 成对到达，up 落在窗口内被忽略，与原来单 down 等价。
 */
export interface MouseTapHandlers {
  readonly onMouseDown: () => void;
  readonly onMouseUp: () => void;
}

/** down/up 去重窗口（ms）。正常一次点按的 down→up 间隔远小于此值。 */
export const MOUSE_TAP_DEDUP_MS = 500;

/**
 * 包一个无参回调为 down/up 双通道 handler。
 * 每个调用方创建一个实例（Solid 组件体内 const 持有即可，组件只执行一次）。
 */
export function createTapHandler(fn: () => void, dedupMs: number = MOUSE_TAP_DEDUP_MS): MouseTapHandlers {
  let lastDownAt = -Infinity;
  return {
    onMouseDown: () => {
      lastDownAt = Date.now();
      fn();
    },
    onMouseUp: () => {
      if (Date.now() - lastDownAt > dedupMs) {
        lastDownAt = Date.now();
        fn();
      }
    },
  };
}
