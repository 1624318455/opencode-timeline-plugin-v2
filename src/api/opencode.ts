import type { Plugin } from "@opencode/plugin/tui";
import type { SessionMessageInfo } from "@opencode/client";
import { truncateSummary, type TimelineNode } from "../types";

/**
 * 与 OpenCode V2 核心交互的封装（V2 专用包）。
 *
 * 数据源：`ctx.data.session.message.list(sessionID)`（V2 消息内联文本，无需 parts 二次查询）。
 * 实时性：`ctx.data.listen` 全事件订阅 + 100ms trailing 合并 + 同步后签名比对；
 * 另有调用方的 2s 轮询兜底（见 useMessages）。
 */

export type TuiContext = Plugin.Context;

/** 跳转记忆持久化（V2 ctx.storage 实现，见 tui.tsx） */
export interface TimelinePersist {
  readonly getLast: (sessionID: string) => string | null;
  readonly setLast: (sessionID: string, messageID: string) => void;
}

/**
 * 单条消息分类（归一化与诊断共用同一口径，避免两边规则分叉）：
 * - kind=user：V2 `{ type: "user" }`，兼容 V1 `{ role: "user" }`；
 * - id：id → messageID → message_id 回退，取不到为 null。
 */
export function describeMessage(m: unknown): { kind: "user" | "other"; id: string | null } {
  try {
    if (!m || typeof m !== "object") return { kind: "other", id: null };
    const raw = m as unknown as Record<string, unknown>;
    if (raw["type"] !== "user" && raw["role"] !== "user") return { kind: "other", id: null };
    const idRaw = raw["id"] ?? raw["messageID"] ?? raw["message_id"];
    return { kind: "user", id: typeof idRaw === "string" && idRaw ? idRaw : null };
  } catch {
    return { kind: "other", id: null };
  }
}

/** 用户消息正文：V2 内联 text，缺正文保留 "(empty)" 节点 */
function messageText(raw: Record<string, unknown>): string {
  try {
    const inline = raw["text"];
    if (typeof inline === "string" && inline.trim()) return inline;
    const s = raw["summary"] as { title?: unknown } | undefined;
    if (typeof s?.title === "string" && s.title.trim()) return s.title;
  } catch {
    /* 忽略，走回退 */
  }
  return "(empty)";
}

/**
 * SessionMessageInfo[] → TimelineNode[]（线性 MVP）。
 * 只保留用户消息节点，assistant / tool / system 全部过滤掉。
 * 显示顺序：最新的在最上面（数组 index 0 = 最新），seq 仍是全局 chronological 序号。
 * 单条解析失败只跳过该条，不让整列表崩掉。
 */
export function toTimelineNodes(
  messages: readonly SessionMessageInfo[],
  sessionId: string,
  maxItems = 50,
): TimelineNode[] {
  if (!Array.isArray(messages)) return [];
  const users: Array<{ id: string; created: number; text: string }> = [];
  for (const m of messages) {
    try {
      const desc = describeMessage(m);
      if (desc.kind !== "user" || !desc.id) continue;
      const raw = m as unknown as Record<string, unknown>;
      const time = raw["time"] as { created?: unknown } | undefined;
      const created = typeof time?.created === "number" ? time.created : 0;
      users.push({ id: desc.id, created, text: messageText(raw) });
    } catch {
      continue;
    }
  }
  const tail = users.slice(Math.max(0, users.length - maxItems));
  const base = users.length - tail.length;
  const chronological = tail.map((u, i) => ({
    id: u.id,
    role: "user" as const,
    summary: truncateSummary(u.text),
    timestamp: u.created,
    seq: base + i,
    sessionId,
  }));
  return chronological.reverse();
}

/**
 * 订阅事件 → 有本会话变化时回调（返回取消订阅函数）。
 * V2 事件经 `ctx.data.listen` 全量接收，按 `data.sessionID` 过滤；
 * 流式高频事件用 trailing 合并（100ms 内只刷一次），先 sync 再读快照。
 */
export function subscribeTimeline(
  ctx: TuiContext,
  sessionID: string,
  onChange: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const schedule = () => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      try {
        void ctx.data.session.message
          .sync(sessionID)
          .catch(() => {})
          .then(() => {
            if (!disposed) onChange();
          });
      } catch {
        if (!disposed) onChange();
      }
    }, 100);
  };
  const off = ctx.data.listen((event) => {
    try {
      const d = event.details as unknown as { data?: { sessionID?: unknown } };
      const sid = d?.data?.sessionID;
      if (sid === undefined || sid === sessionID) schedule();
    } catch {
      /* 坏事件只跳过 */
    }
  });
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      off();
    } catch {
      /* 忽略 */
    }
  };
}

/** 用户消息总数（与 describeMessage 同口径，专供 hiddenOlder / 空态判断） */
export function countUserMessages(ctx: TuiContext, sessionID: string): number {
  try {
    const list = ctx.data.session.message.list(sessionID) ?? [];
    let n = 0;
    for (const m of list) {
      if (describeMessage(m).kind === "user") n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** 单页拉取超时（ms）：请求无期限挂起时转失败，不让面板永远卡在“拉取历史中” */
const PAGE_TIMEOUT_MS = 10000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([
    p.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    timeout,
  ]);
}

/**
 * 服务端全量用户历史（绕开 TUI 本地分页窗口）。
 *
 * 背景：TUI 本地只加载最近一屏消息做分页（长消息占满视口时窗口里可能只有 1 条），
 * `message.list()` 看到的只是这个窗口，原生 /timeline 同理。直接调服务端
 * `message.list({ type: "user", order: "desc" })` 分页拉全量，不依赖主视图滚动位置。
 * 只拉当前会话（sessionID 限定），与其它会话无关。
 * 单次默认拉到 maxItems；total 为用户消息总数（10 页/1000 条封顶，超了按截断计）。
 */
export async function fetchUserHistory(
  ctx: TuiContext,
  sessionID: string,
  maxItems = 50,
): Promise<{ nodes: TimelineNode[]; total: number; truncated: boolean }> {
  const all: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  const LIMIT = 100;
  const MAX_PAGES = 10;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    // 注意：服务端要求 cursor 与 order 不可同传（openapi 注明 Do not combine with order），
    // 首页用 order=desc 取最新，翻页只带 cursor。
    const res = await withTimeout(
      ctx.client.message.list({
        sessionID,
        type: "user",
        limit: LIMIT,
        ...(cursor ? { cursor } : { order: "desc" as const }),
      }),
      PAGE_TIMEOUT_MS,
      `message.list page ${page}`,
    );
    if (Array.isArray(res.data)) all.push(...res.data);
    const next = res.cursor?.next ?? null;
    if (!next || res.data.length === 0) break;
    cursor = next;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  // desc（新→老）翻回 asc（老→新），复用 toTimelineNodes 的 tail+reverse 逻辑
  const asc = all.slice().reverse();
  return { nodes: toTimelineNodes(asc, sessionID, maxItems), total: all.length, truncated };
}

/** 读取某会话当前全量节点（同步快照）。调用方保证刷新时机（事件订阅/version 信号）。 */
export function getSessionNodes(
  ctx: TuiContext,
  sessionID: string,
  maxItems = 50,
): TimelineNode[] {
  let messages: readonly SessionMessageInfo[];
  try {
    messages = ctx.data.session.message.list(sessionID) ?? [];
  } catch {
    return [];
  }
  return toTimelineNodes(messages, sessionID, maxItems);
}

/** 面板诊断行：结论式，一眼定位“宿主没给”还是“过滤吃掉”。全部防御式读取，永不抛错。 */
export function getTimelineDebugLine(
  ctx: TuiContext,
  sessionID: string,
  server?: { kept: number; total: number } | null,
): string {
  try {
    let hasSession = 0;
    try {
      hasSession = ctx.data.session.get(sessionID) === undefined ? 0 : 1;
    } catch {
      hasSession = -1;
    }
    let total = -1;
    let user = 0;
    let noId = 0;
    let firstUserId: string | null = null;
    try {
      const list = ctx.data.session.message.list(sessionID) ?? [];
      total = list.length;
      for (const m of list) {
        const d = describeMessage(m);
        if (d.kind !== "user") continue;
        user++;
        if (d.id) firstUserId ??= d.id;
        else noId++;
      }
    } catch {
      total = -1;
    }
    let kept = -1;
    try {
      kept = getSessionNodes(ctx, sessionID, Number.MAX_SAFE_INTEGER).length;
    } catch {
      kept = -1;
    }
    let msg = "?";
    if (!firstUserId) {
      msg = user === 0 ? "n/a" : "no-id";
    } else {
      try {
        msg = ctx.data.session.message.get(sessionID, firstUserId) === undefined ? "missing" : "ok";
      } catch {
        msg = "err";
      }
    }
    const shortId = String(sessionID ?? "?").slice(0, 13);
    const srv = server ? ` srvKept=${server.kept} srvTotal=${server.total}` : "";
    return `dbg s=${hasSession} total=${total} user=${user} kept=${kept} noId=${noId} msg=${msg}${srv} ${shortId}`;
  } catch {
    return "dbg unavailable";
  }
}

/** toast 小包（V2: ctx.ui.toast.show） */
function toast(ctx: TuiContext, message: string, variant?: "info" | "success" | "warning" | "error"): void {
  try {
    ctx.ui.toast.show(variant ? { message, variant } : { message });
  } catch {
    /* 忽略 */
  }
}

/**
 * 跳转到对应消息。
 * 1) persist 记住选中（kv 语义）；
 * 2) 渲染树 best-effort：从 ctx.renderer.root.findDescendantById 定位消息行，
 *    沿 parent 链找 ScrollBox 调 scrollChildIntoView，找不到则 DFS 全树搜；
 * 3) 兜底：toast 说明（保持 MVP 行为，不抛错）。
 *
 * 注意：TUI 本地只加载最近消息做分页，太老的消息可能没有渲染节点，此时返回 false。
 */
export function jumpToMessage(
  ctx: TuiContext,
  persist: TimelinePersist,
  sessionID: string,
  messageID: string,
): boolean {
  try {
    persist.setLast(sessionID, messageID);
  } catch {
    /* 存储不可用时忽略 */
  }
  const short = messageID.slice(0, 8);
  if (tryRendererTreeJump(ctx, messageID)) {
    toast(ctx, `timeline: jump → ${short}…`, "success");
    return true;
  }
  // 老消息尚未加载进主视图窗口时没有原生渲染节点（transcript 分页所致）。
  // 实测结论：编程式滚顶（scrollTo(0)）触发不了 V2 宿主的向上分页（8 轮均失败），
  // 且失败会把 transcript 晾在顶部，负体验；故不做自动翻页，直接给诚实指引。
  toast(ctx, `timeline: 该消息不在主视图窗口（${short}…已记住），上滚 transcript 加载后再点`);
  return false;
}

type RenderableLike = {
  readonly id?: unknown;
  readonly y?: unknown;
  parent?: unknown;
  findDescendantById?: unknown;
  getChildren?: unknown;
  scrollChildIntoView?: unknown;
  scrollBy?: unknown;
  scrollTo?: unknown;
  scrollTop?: unknown;
  scrollHeight?: unknown;
  content?: unknown;
  viewport?: unknown;
  wrapper?: unknown;
};

function isScrollBox(node: RenderableLike): boolean {
  return (
    typeof node.scrollChildIntoView === "function" ||
    typeof node.scrollBy === "function" ||
    typeof node.scrollTo === "function"
  );
}

function findScrollBoxAncestor(target: RenderableLike): RenderableLike | null {
  let cur: unknown = target.parent ?? null;
  let hops = 0;
  while (cur && typeof cur === "object" && hops < 64) {
    const node = cur as RenderableLike;
    if (isScrollBox(node)) return node;
    cur = node.parent ?? null;
    hops++;
  }
  return null;
}

function scrollBoxToMessage(scrollBox: RenderableLike, target: RenderableLike, messageID: string): boolean {
  try {
    if (typeof scrollBox.scrollChildIntoView === "function") {
      (scrollBox.scrollChildIntoView as (id: string) => void).call(scrollBox, messageID);
      return true;
    }
    if (typeof scrollBox.scrollBy === "function") {
      const childY = (target as { y?: unknown }).y;
      const scrollY = (scrollBox as { y?: unknown }).y;
      if (typeof childY === "number" && typeof scrollY === "number") {
        (scrollBox.scrollBy as (delta: number) => void).call(scrollBox, childY - scrollY - 1);
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function collectScrollBoxes(root: RenderableLike): RenderableLike[] {
  const out: RenderableLike[] = [];
  const seen = new Set<object>();
  const stack: RenderableLike[] = [root];
  let steps = 0;
  while (stack.length > 0 && steps < 5000) {
    steps++;
    const node = stack.pop()!;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (isScrollBox(node)) out.push(node);
    try {
      const kids =
        typeof node.getChildren === "function" ? (node.getChildren as () => unknown).call(node) : null;
      if (Array.isArray(kids)) {
        for (const k of kids) {
          if (k && typeof k === "object") stack.push(k as RenderableLike);
        }
      }
      for (const key of ["content", "viewport", "wrapper"] as const) {
        const sub = node[key];
        if (sub && typeof sub === "object") stack.push(sub as RenderableLike);
      }
    } catch {
      continue;
    }
  }
  return out;
}

function nodeContains(root: RenderableLike, messageID: string): boolean {
  try {
    if (typeof root.findDescendantById === "function") {
      return (root.findDescendantById as (id: string) => unknown).call(root, messageID) != null;
    }
  } catch {
    return false;
  }
  return false;
}

/** 主会话视图回到底部：用本会话已知消息 id 定位 transcript 的 ScrollBox，然后 scrollTo(scrollHeight)。 */
export function scrollSessionToBottom(
  ctx: TuiContext,
  knownIds: readonly string[],
): boolean {
  const box = findSessionScrollBox(ctx, knownIds);
  if (!box) {
    toast(ctx, "timeline: 找不到会话视图，回不到底部");
    return false;
  }
  if (!scrollBoxToBottom(box)) {
    toast(ctx, "timeline: 回到底部失败");
    return false;
  }
  try {
    ctx.renderer.requestRender();
  } catch {
    /* 忽略 */
  }
  toast(ctx, "timeline: 已回到底部", "success");
  return true;
}

function findSessionScrollBox(ctx: TuiContext, knownIds: readonly string[]): RenderableLike | null {
  try {
    const root = ctx.renderer.root as unknown as RenderableLike | undefined;
    if (!root || typeof root.findDescendantById !== "function") return null;
    const find = root.findDescendantById as (id: string) => unknown;
    for (const id of knownIds) {
      let target: unknown = null;
      try {
        target = find.call(root, id);
      } catch {
        continue;
      }
      if (!target || typeof target !== "object") continue;
      const t = target as RenderableLike;
      const ancestor = findScrollBoxAncestor(t);
      if (ancestor) return ancestor;
      for (const box of collectScrollBoxes(root)) {
        try {
          if (nodeContains(box, id)) return box;
        } catch {
          continue;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function scrollBoxToBottom(scrollBox: RenderableLike): boolean {
  try {
    const h = scrollBox.scrollHeight;
    if (typeof h !== "number") return false;
    if (typeof scrollBox.scrollTo === "function") {
      (scrollBox.scrollTo as (pos: number) => void).call(scrollBox, h);
      return true;
    }
    if ("scrollTop" in (scrollBox as object)) {
      (scrollBox as { scrollTop: number }).scrollTop = h;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function tryRendererTreeJump(ctx: TuiContext, messageID: string): boolean {
  try {
    const root = ctx.renderer.root as unknown as RenderableLike | undefined;
    if (!root || typeof root.findDescendantById !== "function") return false;
    const target = (root.findDescendantById as (id: string) => unknown).call(
      root,
      messageID,
    ) as RenderableLike | null | undefined;
    if (!target || typeof target !== "object") return false;
    const ancestor = findScrollBoxAncestor(target);
    if (ancestor && scrollBoxToMessage(ancestor, target, messageID)) {
      try {
        ctx.renderer.requestRender();
      } catch {
        /* 忽略 */
      }
      return true;
    }
    for (const box of collectScrollBoxes(root)) {
      try {
        if (!nodeContains(box, messageID)) continue;
        if (scrollBoxToMessage(box, target, messageID)) {
          try {
            ctx.renderer.requestRender();
          } catch {
            /* 忽略 */
          }
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}
