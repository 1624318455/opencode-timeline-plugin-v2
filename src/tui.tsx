/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { TimelinePanel } from "./components/TimelinePanel";
import type { TimelinePersist } from "./api/opencode";

export const id = "timeline.viewer";

interface TimelinePluginOptions {
  readonly maxItems?: number;
  /** 诊断行开关（默认关闭：dbg 快照行只在排查时打开，避免打扰普通用户） */
  readonly debug?: boolean;
}

function readOptions(options: Readonly<Record<string, unknown>> | undefined): TimelinePluginOptions {
  if (!options || typeof options !== "object") return {};
  const raw = options as Record<string, unknown>;
  const maxItems = raw["maxItems"];
  const debug = raw["debug"];
  return {
    ...(typeof maxItems === "number" ? { maxItems } : {}),
    ...(debug === true ? { debug: true } : {}),
  };
}

/**
 * V2 CLI 插件入口。
 * 挂载点：sidebar.content（按 sessionID 区分会话）。
 * setup 返回 slot 注销函数，停用/卸载时自动摘除面板。
 */
export default Plugin.define({
  id,
  setup(ctx) {
    const { maxItems = 50, debug = false } = readOptions(
      ctx.options as Readonly<Record<string, unknown>> | undefined,
    );

    // 跳转记忆：V2 storage（按插件 id 隔离，跨重启持久，多 TUI 实例同步）。
    const [store, updateStore] = ctx.storage.store("timeline.viewer", {
      initial: { lastBySession: {} as Record<string, string> },
    });
    const persist: TimelinePersist = {
      getLast: (sessionID) => store.lastBySession[sessionID] ?? null,
      setLast: (sessionID, messageID) => {
        void updateStore((draft) => {
          draft.lastBySession[sessionID] = messageID;
        }).catch(() => {});
      },
    };

    // 重挂载机制。
    // V2 宿主对插件自有响应式更新不排帧（数据到、store 写成功、requestRender
    // 连发均无效，面板冻结在挂载瞬间的值；折叠/展开等交互触发的区域重渲染才会读新鲜值）。
    // 因此数据签名变化时主动摘除并重建 slot claim，用一次新鲜挂载代替推式刷新。
    //
    // 防重要点（偶现双 timeline 的教训）：
    // 1) 保留历次 unsub 句柄，每次重挂前全部调用——某次摘除若在宿主侧丢失，
    //    下次重挂时补摘，不永久泄漏。
    // 2) 摘除与重建错开 tick（同 tick 先摘后建会与宿主发消息时的区域重渲染竞态，
    //    旧 claim 丢失导致并存两份）。
    // 3) 单飞行 + 节流：重挂至少间隔 1s，堆积的签名只取最新。
    let handles: Array<() => void> = [];
    let lastRemountedSig = "";
    let remountTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingSig: string | null = null;
    let pendingForce = false;
    let lastRemountAt = 0;
    const REMOUNT_MIN_INTERVAL = 1000;
    const detachAll = (): void => {
      const hs = handles;
      handles = [];
      for (const h of hs) {
        try {
          h();
        } catch {
          /* 忽略 */
        }
      }
    };
    const attach = (): void => {
      const unsub = ctx.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => (
          <TimelinePanel
            ctx={ctx}
            persist={persist}
            sessionID={sessionID}
            maxItems={maxItems}
            debug={debug}
            onContentChanged={(sig) => requestRemount(sig)}
            onSelectionChanged={() => requestRemountForce()}
          />
        ),
      });
      handles.push(unsub);
    };
    const requestRemount = (sig: string): void => {
      if (!sig || sig === "0") return;
      pendingSig = sig;
      scheduleRemount();
    };
    // 选中变化强制重挂（无视签名守卫，仍走节流/单飞行）：高亮只能靠新鲜挂载刷出来
    const requestRemountForce = (): void => {
      pendingForce = true;
      scheduleRemount();
    };
    const scheduleRemount = (): void => {
      if (remountTimer !== undefined) return;
      const wait = Math.max(0, REMOUNT_MIN_INTERVAL - (Date.now() - lastRemountAt));
      remountTimer = setTimeout(() => {
        remountTimer = undefined;
        const s = pendingSig;
        const force = pendingForce;
        pendingSig = null;
        pendingForce = false;
        if (!force && (!s || s === "0" || s === lastRemountedSig)) return;
        if (s) lastRemountedSig = s;
        lastRemountAt = Date.now();
        detachAll();
        try {
          attach();
        } catch {
          /* 忽略 */
        }
      }, wait);
    };
    attach();

    return () => {
      try {
        if (remountTimer !== undefined) clearTimeout(remountTimer);
      } catch {
        /* 忽略 */
      }
      detachAll();
    };
  },
});
