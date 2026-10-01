/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, on, onCleanup, Show } from "solid-js";
import type { TimelineNode } from "../types";
import { domIdFor } from "../types";
import { NodeItem } from "./NodeItem";
import type { TuiContext } from "../api/opencode";

type ThemeColor = TuiContext["theme"]["text"]["base"];

export interface TimelineProps {
  readonly nodes: readonly TimelineNode[];
  /** 当前选中节点的 id（受控状态，useMessages 持有） */
  readonly selectedId: string | null;
  /** 主题色（面板层从 ctx.theme 映射后传入） */
  readonly selectedBackground?: ThemeColor;
  readonly borderColor?: ThemeColor;
  readonly textColor?: ThemeColor;
  readonly timeColor?: ThemeColor;
  readonly emptyText?: string;
  /** 列表最大高度（行数）。侧边栏是共享空间，禁止 flexGrow 抢占其他区块 */
  readonly maxHeight?: number;
  /** 点击回调（鼠标点行 → 面板层 selectAndJump：选中 + 跳转主视图；键盘 Enter 走同一跳转） */
  readonly onSelect?: (id: string) => void;
}

/** 时间线列表：可滚动（scrollbox）+ 空态 + 选中行自动滚入视口 */
export function Timeline(props: TimelineProps) {
  let scroll: ScrollBoxRenderable | undefined;
  let pendingScroll: ReturnType<typeof setTimeout> | undefined;

  const clearPendingScroll = () => {
    if (pendingScroll === undefined) return;
    clearTimeout(pendingScroll);
    pendingScroll = undefined;
  };

  // 选中行自动滚入视口（只在自家小列表内找带前缀的 id，不碰 transcript）：找不到子节点时下一 tick 重试
  const scrollToSelected = (id: string | null) => {
    clearPendingScroll();
    if (!id) return;
    const domId = domIdFor(id);
    const tryScroll = () => {
      pendingScroll = undefined;
      if (!scroll) return;
      const child = scroll.content.findDescendantById(domId);
      if (!child || scroll.viewport.height <= 0 || child.height <= 0) {
        pendingScroll = setTimeout(tryScroll, 0);
        return;
      }
      scroll.scrollChildIntoView(domId);
    };
    pendingScroll = setTimeout(tryScroll, 0);
  };

  createEffect(
    on(
      () => props.selectedId,
      (id) => scrollToSelected(id ?? null),
      { defer: true },
    ),
  );

  onCleanup(() => clearPendingScroll());

  return (
    <scrollbox
      ref={(renderable: ScrollBoxRenderable) => (scroll = renderable)}
      width="100%"
      flexGrow={0}
      flexShrink={1}
      minHeight={0}
      maxHeight={props.maxHeight ?? 10}
      scrollbarOptions={{ visible: false }}
    >
      <Show when={props.nodes.length > 0}>
        <box flexDirection="column" gap={0} width="100%">
          <For each={props.nodes}>
            {(node: TimelineNode) => (
              <NodeItem
                node={node}
                selected={node.id === props.selectedId}
                selectedBackground={props.selectedBackground}
                borderColor={props.borderColor}
                textColor={props.textColor}
                timeColor={props.timeColor}
                onSelect={props.onSelect}
              />
            )}
          </For>
        </box>
      </Show>
      <Show when={props.nodes.length === 0}>
        <text>{props.emptyText ?? "暂无消息"}</text>
      </Show>
    </scrollbox>
  );
}
