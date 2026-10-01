/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import type { TuiContext } from "../api/opencode";
import { cellsWidth, domIdFor, fitCells, formatTime, roleIcon, type TimelineNode } from "../types";
import { createTapHandler } from "../hooks/useMouseTap";

type ThemeColor = TuiContext["theme"]["text"]["base"];

export interface NodeItemProps {
  readonly node: TimelineNode;
  readonly selected: boolean;
  /** 选中行背景/边框色（面板层从 ctx.theme 传入） */
  readonly selectedBackground?: ThemeColor;
  readonly borderColor?: ThemeColor;
  /** 正文色 / 时间色（时间用弱化色，与正文区分） */
  readonly textColor?: ThemeColor;
  readonly timeColor?: ThemeColor;
  /** 鼠标点击回调（面板层接 selectAndJump：选中 + 跳转主视图） */
  readonly onSelect?: (id: string) => void;
}

/** 摘要列宽（cells）+ 最小间隔（cells）：前缀恒定，时间自然成一列。
 * 实测侧边栏内容宽 37 格：1(空格)+2(图标按宽字符计)+1(空格)+24(摘要)+2(间隔)+5(时间)=35，
 * 留 2 格余量，任何行都不触发 yoga 收缩裁剪。 */
const SUMMARY_CELLS = 24;
const GAP_CELLS = 2;

/** 单个消息节点：`[角色图标] 消息摘要（30 cells）  HH:MM`，选中时加粗 + 左边框 + ▸ 标记；点击直接跳转 */
export function NodeItem(props: NodeItemProps) {
  // macOS 适配：部分终端只送达 release 不送达 press，双通道 tap 兜底（Windows 下 up 被去重，等价于纯 down）
  const tap = createTapHandler(() => props.onSelect?.(props.node.id));
  // 列对齐不能靠文本首尾空格（渲染器会裁）：摘要按 cell 截断，间隔用物理 spacer 盒子，
  // 各行前缀恒定（图标 1 + 空格 1 + 摘要 30 + 间隔 2），时间自然成一列。
  const content = () => fitCells(props.node.summary, SUMMARY_CELLS).trimEnd();
  const gapWidth = () => SUMMARY_CELLS - Math.min(SUMMARY_CELLS, cellsWidth(content())) + GAP_CELLS;
  return (
    <box
      id={domIdFor(props.node.id)}
      width="100%"
      flexDirection="row"
      backgroundColor={props.selected ? props.selectedBackground : undefined}
      border={props.selected ? ["left"] : undefined}
      borderColor={props.selected ? props.borderColor : undefined}
      onMouseDown={tap.onMouseDown}
      onMouseUp={tap.onMouseUp}
    >
      <text
        wrapMode="none"
        fg={props.textColor}
        attributes={props.selected ? TextAttributes.BOLD : undefined}
      >
        {`${props.selected ? "▸" : " "}${roleIcon(props.node.role)} ${content()}`}
      </text>
      <box width={gapWidth()} />
      <text wrapMode="none" fg={props.timeColor}>
        {formatTime(props.node.timestamp)}
      </text>
    </box>
  );
}
