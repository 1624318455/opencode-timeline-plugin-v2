// 时间线核心类型：线性消息列表（MVP），预留 parentId/children 给未来树状扩展。

/** 消息角色：用户 / AI / 工具调用 / 系统 */
export type MessageRole = "user" | "assistant" | "tool" | "system";

/** 单条会话消息的归一化视图（与 OpenCode 原始消息结构解耦，转换逻辑在 api/opencode.ts） */
export interface TimelineNode {
  /** 消息唯一 ID（对应 OpenCode 的 messageID） */
  readonly id: string;
  readonly role: MessageRole;
  /** 正文摘要（已截断到 30 字符，见 truncateSummary） */
  readonly summary: string;
  /** Unix 毫秒时间戳 */
  readonly timestamp: number;
  /** 会话内序号（可选，用于排序/跳转） */
  readonly seq?: number;
  /** 所属会话（Sidebar slot 按 session_id 挂载时使用） */
  readonly sessionId?: string;
  // —— 树状扩展预留（对标 opencode-tree），MVP 可忽略 ——
  readonly parentId?: string;
  readonly children?: readonly string[];
}

/** 自家行盒子的渲染树 id 前缀：必须与 transcript 原生消息 id 区分开，
 * 否则跳转用的 findDescendantById 会先撞见侧边栏自己（滚小列表而非主视图）。 */
export const NODE_ID_PREFIX = "timeline-node:";

export function domIdFor(messageID: string): string {
  return `${NODE_ID_PREFIX}${messageID}`;
}

/** 摘要最大长度（需求：截断到 30 字符） */
export const MAX_SUMMARY_LENGTH = 30;

/** 按字符截断（含 CJK/emoji 安全处理），超长补 "…" */
export function truncateSummary(text: string, max: number = MAX_SUMMARY_LENGTH): string {
  const chars = Array.from(text.trim().replace(/\s+/g, " "));
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`;
}

/** 单个字符的终端 cell 宽度（CJK/全角/emoji 按 2 算，其余 1） */
export function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x1100) return 1;
  if (cp <= 0x115f) return 2; // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2; // CJK 部首/符号/假名/谚文/注音
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul 音节
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK 兼容表意
  if (cp >= 0xfe30 && cp <= 0xfe4f) return 2; // CJK 兼容形
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // 全角 ASCII/半宽片假名区
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2; // 全角符号
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2; // emoji 主区
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK 扩展
  return 1;
}

/** 整串的终端 cell 宽度 */
export function cellsWidth(text: string): number {
  let w = 0;
  for (const ch of Array.from(text)) w += cellWidth(ch);
  return w;
}

/**
 * 按 cell 宽度截断并右补空格到固定宽度（终端表格列对齐用）。
 * 渲染器可能裁掉文本节点首尾空白，因此列对齐必须靠“内容等宽”而非首尾空格：
 * 调用方保持前缀总 cell 数恒定，时间自然成一列。
 */
export function fitCells(text: string, width: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  let w = 0;
  let out = "";
  for (const ch of Array.from(clean)) {
    const cw = cellWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out + " ".repeat(Math.max(0, width - w));
}

/** 角色标记（纯几何符号，无 emoji，保证终端观感克制统一） */
export function roleIcon(role: MessageRole): string {
  switch (role) {
    case "user":
      return "○";
    case "assistant":
      return "●";
    case "tool":
      return "◇";
    case "system":
      return "□";
  }
}

/** 时间戳 → "HH:MM"（本地时区） */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
