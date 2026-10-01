import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import {
  countUserMessages,
  fetchUserHistory,
  getSessionNodes,
  jumpToMessage,
  scrollSessionToBottom,
  subscribeTimeline,
  type TimelinePersist,
  type TuiContext,
} from "../api/opencode";
import type { TimelineNode } from "../types";

export interface UseMessagesOptions {
  readonly maxItems?: number;
  /** 内容签名变化回调（面板重挂载用，内部已 untrack，调用方须自行防重） */
  readonly onContentChanged?: (sig: string) => void;
  /** 选中变化回调（重挂载刷出高亮用） */
  readonly onSelectionChanged?: () => void;
}

export interface UseMessagesResult {
  readonly nodes: () => readonly TimelineNode[];
  /** 快照签名（长度+首尾 id），面板层据此翻转标题重挂开关 */
  readonly sig: () => string;
  /** 标题重挂钥匙：follow effect 里签名一变就 +1，面板用整块重挂标题 */
  readonly paintKey: () => number;
  readonly userTotal: () => number;
  /** 服务端拉取状态（面板空态文案用） */
  readonly fetchState: () => "idle" | "loading" | "ok" | "error";
  /** 最近一次拉取失败原因（无失败时为 null，截断展示用） */
  readonly fetchError: () => string | null;
  readonly selectedId: () => string | null;
  readonly setSelectedId: (id: string | null) => void;
  readonly visible: () => boolean;
  readonly loading: () => boolean;
  readonly toggle: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly confirmSelection: () => void;
  /** 鼠标点击：选中该行 + 直接跳转主视图（与 Enter 同一跳转） */
  readonly selectAndJump: (id: string) => void;
  /** 回到底部：主会话视图滚到最新处（可传实时 id 列表，避免 memo 滞后） */
  readonly backToBottom: (ids?: readonly string[]) => void;
  readonly refresh: () => void;
}

/** sessionID 支持传值或 accessor（sidebar 切会话时 props 更新但组件不重挂，必须响应式跟随） */
type SessionIDSource = string | (() => string);
function readSessionID(src: SessionIDSource): string {
  return typeof src === "function" ? (src as () => string)() : src;
}

/** 快照签名：长度 + 首尾 id，轮询比对用（命中则跳过 bump，避免无谓重算） */
function sigOf(list: readonly TimelineNode[]): string {
  return list.length === 0
    ? "0"
    : `${list.length}:${list[0]!.id.slice(0, 8)}..${list[list.length - 1]!.id.slice(0, 8)}`;
}

/**
 * 会话消息列表 Hook（混合模式，V2）。
 * 三路驱动：1) data.listen 事件 → trailing 合并 → sync → bump；
 * 2) 切会话/挂载后的延迟 catch-up bump；3) 2s 轮询签名比对。
 */
export function useMessages(
  ctx: TuiContext,
  persist: TimelinePersist,
  sessionID: SessionIDSource,
  options: UseMessagesOptions = {},
): UseMessagesResult {
  const maxItems = options.maxItems ?? 50;
  const onContentChanged = options.onContentChanged;
  const onSelectionChanged = options.onSelectionChanged;
  const id = () => readSessionID(sessionID);

  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  // 服务端全量状态（声明前移：下方 memos 首轮创建即执行读，放后面会撞 TDZ）。
  // 数据放在宿主 storage.memory 里而非插件自有 signal：宿主对其自家 store 的
  // 变更必调度重绘；插件自有 signal 在宿主帧调度之外，实测数据到了也不画。
  type FetchState = "idle" | "loading" | "ok" | "error";
  interface FetchEntry {
    readonly nodes: TimelineNode[];
    readonly total: number;
  }
  const [fetchStore, updateFetch] = ctx.storage.memory("timeline.v2.fetch", {
    initial: {
      bySession: {} as Record<string, FetchEntry>,
      state: "idle" as FetchState,
      error: null as string | null,
    },
  });
  const serverEntry = (sid: string): FetchEntry | null => {
    try {
      return fetchStore.bySession[sid] ?? null;
    } catch {
      return null;
    }
  };

  // 路由失活判断：宿主切到别的会话后，轮询只做廉价跳过，避免僵尸实例刷屏烧 CPU。
  const isRouteStale = () => {
    try {
      const cur = ctx.ui.router.current();
      if (!cur || cur.type !== "session") return false;
      return cur.sessionID !== id();
    } catch {
      return false;
    }
  };

  const nodes = createMemo(() => {
    try {
      version();
      const sid = id();
      let local: readonly TimelineNode[] = [];
      try {
        local = getSessionNodes(ctx, sid, maxItems);
      } catch {
        /* 忽略 */
      }
      const s = serverEntry(sid)?.nodes ?? null;
      if (s && (s.length > 0 || local.length === 0)) return s;
      return local;
    } catch {
      return [] as readonly TimelineNode[];
    }
  });
  const userTotal = createMemo(() => {
    try {
      version();
      const t = serverEntry(id())?.total ?? null;
      if (t !== null) return t;
      return countUserMessages(ctx, id());
    } catch {
      return 0;
    }
  });
  const sig = createMemo(() => sigOf(nodes()));
  const [paintKey, setPaintKey] = createSignal(0);
  let prevPaintSig = "";
  const loading = createMemo(() => {
    if (nodes().length > 0) return false;
    try {
      return ctx.data.session.get(id()) === undefined;
    } catch {
      return true;
    }
  });

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [visible, setVisible] = createSignal(true);
  const [kvRestored, setKvRestored] = createSignal(false);

  // 服务端全量写入与刷帧（状态声明见上）。切会话立即拉，事件/轮询节流 2s。
  let lastFetchAt = 0;
  let fetchSeq = 0;
  // 刷帧 volley：单次 requestRender 可能被宿主帧合并吃掉，连发多轮确保刷出来；
  // 同时自检 renderer 可用性，缺失则写入 error 供面板展示。
  const paintVolley = () => {
    try {
      const r = ctx.renderer as unknown as { requestRender?: unknown; render?: unknown } | undefined;
      if (!r || typeof r.requestRender !== "function") {
        updateFetch((draft) => {
          if (draft.state !== "error") {
            draft.state = "error";
            draft.error = "no-requestRender";
          }
        });
        return;
      }
      const rr = r.requestRender as () => void;
      const fire = () => {
        try {
          rr.call(r);
        } catch {
          /* 忽略 */
        }
      };
      fire();
      for (const ms of [150, 500, 1500]) {
        setTimeout(fire, ms);
      }
    } catch {
      /* 忽略 */
    }
  };
  // 已上屏签名：只在数据变化时碰宿主缓存，避免无意义 churn。
  // 宿主只在自家缓存变化/用户交互/requestRender 时排帧，而 requestRender 对
  // 插件自有渲染树疑似无效；因此数据变化后主动 sync 一次宿主消息缓存，
  // 借宿主的排帧把新值带上屏（sync 只刷新缓存窗口，不动滚动位置）。
  let lastPaintedSig = "";
  const refreshServer = (immediate: boolean) => {
    const sid = id();
    const now = Date.now();
    if (!immediate && now - lastFetchAt < 2000) return;
    lastFetchAt = now;
    const my = ++fetchSeq;
    updateFetch((draft) => {
      draft.state = "loading";
    });
    void (async () => {
      try {
        const { nodes: fresh, total } = await fetchUserHistory(ctx, sid, maxItems);
        if (my !== fetchSeq || isRouteStale()) return;
        updateFetch((draft) => {
          draft.bySession[sid] = { nodes: fresh, total };
          draft.state = "ok";
          draft.error = null;
        });
        bump();
        if (sigOf(fresh) !== lastPaintedSig) {
          lastPaintedSig = sigOf(fresh);
          try {
            await ctx.data.session.message.sync(sid);
          } catch {
            /* 忽略 */
          }
        }
        paintVolley();
        try {
          onContentChanged?.(sigOf(fresh));
        } catch {
          /* 忽略 */
        }
      } catch (e) {
        if (my !== fetchSeq) return;
        updateFetch((draft) => {
          draft.state = "error";
          try {
            const msg = e instanceof Error ? e.message : String(e);
            draft.error = msg.slice(0, 120);
          } catch {
            draft.error = "unknown";
          }
        });
        paintVolley();
      }
    })();
  };

  const restoreKv = (list: readonly TimelineNode[]): boolean => {
    try {
      const last = persist.getLast(id());
      if (last && list.some((n) => n.id === last)) {
        setSelectedId(last);
        return true;
      }
    } catch {
      // 存储未就绪则跳过
    }
    return false;
  };

  const followSelection = (list: readonly TimelineNode[]) => {
    if (list.length === 0) {
      setSelectedId(null);
      return;
    }
    if (list.some((n) => n.id === selectedId())) return;
    if (!kvRestored()) {
      setKvRestored(true);
      if (restoreKv(list)) return;
    }
    setSelectedId(list[0]!.id);
  };

  // 事件订阅：按当前会话过滤，随会话切换重建，随面板卸载注销。
  createEffect(() => {
    try {
      const sid = id();
      const off = subscribeTimeline(ctx, sid, () => {
        if (isRouteStale()) return;
        bump();
        refreshServer(false);
      });
      onCleanup(off);
      return off;
    } catch {
      return undefined;
    }
  });

  // 切会话/挂载：重置选中与恢复标记，并补延迟 bump，兜住历史回填窗口。
  const CATCH_UP_DELAYS = [0, 500, 1500, 3000, 6000];
  let prevSid: string | null = null;
  createEffect(() => {
    try {
      const sid = id();
      if (prevSid === sid) return;
      prevSid = sid;
      setKvRestored(false);
      setSelectedId(null);
      // 切会话：不清旧缓存（旧值先顶着，避免空闪），直接全量拉取覆盖
      refreshServer(true);
      try {
        void ctx.data.session.message.sync(sid).catch(() => {});
      } catch {
        /* 忽略 */
      }
      const timers = CATCH_UP_DELAYS.map((ms) =>
        setTimeout(() => {
          if (isRouteStale()) return;
          bump();
        }, ms),
      );
      onCleanup(() => timers.forEach((t) => clearTimeout(t)));
    } catch {
      /* 忽略，effect 保持存活 */
    }
  });

  // follow effect：签名一变 paintKey +1，选中跟随，并显式请求宿主重绘。
  let lastSig = "";
  createEffect(() => {
    try {
      const list = nodes();
      lastSig = sigOf(list);
      const s = lastSig;
      if (prevPaintSig !== s) {
        prevPaintSig = s;
        untrack(() => setPaintKey((k) => k + 1));
      }
      untrack(() => {
        followSelection(list);
        paintVolley();
        // 内容变化即请求重挂载（宿主不给插件帧，只能用新鲜挂载带上屏）
        try {
          onContentChanged?.(s);
        } catch {
          /* 忽略 */
        }
      });
    } catch {
      /* 忽略，effect 保持存活 */
    }
  });
  const pollTimer = setInterval(() => {
    try {
      if (isRouteStale()) return;
      const next = getSessionNodes(ctx, id(), maxItems);
      const sig = sigOf(next);
      if (sig !== lastSig) {
        bump();
        // 本地窗口变化可能是分页回填：顺带刷一次服务端全量（节流 2s）
        refreshServer(false);
        paintVolley();
      }
    } catch {
      /* 快照读失败就等下一轮 */
    }
  }, 2000);
  onCleanup(() => clearInterval(pollTimer));

  const toggle = () => setVisible((v) => !v);

  const moveSelection = (delta: number) => {
    const list = nodes();
    if (list.length === 0) return;
    const idx = list.findIndex((n) => n.id === selectedId());
    if (idx < 0) {
      setSelectedId(list[0]!.id);
      return;
    }
    const next = Math.min(list.length - 1, Math.max(0, idx + delta));
    setSelectedId(list[next]!.id);
  };

  const confirmSelection = () => {
    const selected = selectedId();
    if (selected) jumpToMessage(ctx, persist, id(), selected);
  };

  const selectAndJump = (messageID: string) => {
    setSelectedId(messageID);
    // 选中行高亮依赖重挂载刷出来（宿主不给插件帧），这里触发一次
    try {
      onSelectionChanged?.();
    } catch {
      /* 忽略 */
    }
    jumpToMessage(ctx, persist, id(), messageID);
  };

  const backToBottom = (ids?: readonly string[]) => {
    try {
      scrollSessionToBottom(ctx, ids ?? nodes().map((n) => n.id));
    } catch {
      /* 忽略 */
    }
  };

  const refresh = () => {
    bump();
    followSelection(nodes());
  };

  const fetchState = (): "idle" | "loading" | "ok" | "error" => {
    try {
      return fetchStore.state;
    } catch {
      return "idle";
    }
  };
  const fetchError = (): string | null => {
    try {
      return fetchStore.error;
    } catch {
      return null;
    }
  };

  return {
    nodes,
    sig,
    paintKey,
    userTotal,
    fetchState,
    fetchError,
    selectedId,
    setSelectedId,
    visible,
    loading,
    toggle,
    moveSelection,
    confirmSelection,
    selectAndJump,
    backToBottom,
    refresh,
  };
}
