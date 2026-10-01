/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Show } from "solid-js";
import { Timeline } from "./Timeline";
import { useMessages } from "../hooks/useMessages";
import { createTapHandler } from "../hooks/useMouseTap";
import {
  getTimelineDebugLine,
  type TimelinePersist,
  type TuiContext,
} from "../api/opencode";

export interface TimelinePanelProps {
  readonly ctx: TuiContext;
  readonly persist: TimelinePersist;
  readonly sessionID: string;
  readonly maxItems: number;
  readonly debug: boolean;
  readonly onContentChanged: (sig: string) => void;
  readonly onSelectionChanged: () => void;
}

/**
 * 侧边栏面板：hooks 接线 + 可见性开关 + Timeline 纯展示。
 * - 标题栏永远渲染（0 节点时显示空态文案），避免与"插件未加载"混淆；
 * - 固定 maxHeight，不 flexGrow 抢空间。
 */
export function TimelinePanel(props: TimelinePanelProps) {
  const store = useMessages(props.ctx, props.persist, () => props.sessionID, {
    maxItems: props.maxItems,
    onContentChanged: props.onContentChanged,
    onSelectionChanged: props.onSelectionChanged,
  });
  const [open, setOpen] = createSignal(true);
  const headerTap = createTapHandler(() => setOpen((x) => !x));

  // 显示层读 store.nodes()：服务端全量优先（挂载/切会话即拉，不依赖主视图滚动位置），
  // 未就绪/失败时回退本地快照。更新靠重挂载带上屏（见 tui.tsx），此处只负责读新鲜值。
  const liveNodes = () => store.nodes();
  const liveEmptyText = () => {
    if (liveNodes().length > 0) return "";
    try {
      if (props.ctx.data.session.get(props.sessionID) === undefined) return "加载历史中…";
    } catch {
      return "加载历史中…";
    }
    // 会话存在但 0 节点：把服务端拉取状态直接说出来，避免“暂无”误导
    try {
      const st = store.fetchState();
      if (st === "loading") return "拉取历史中…";
      if (st === "error") {
        const err = store.fetchError();
        return err ? `拉取失败：${err}` : "拉取失败";
      }
    } catch {
      /* 忽略 */
    }
    return "暂无用户消息";
  };
  const active = () => store.visible();
  const hasNodes = () => liveNodes().length > 0;
  const maxHeight = 8;
  const count = () => liveNodes().length;
  // 标题靠“签名变化 → 整块卸了重挂”更新：两分支故意结构不同，渲染器无法复用旧节点。
  const titleText = () => `Timeline ${count()}`;
  const TitleEven = () => {
    return <text fg={theme().text.muted}>{titleText()}</text>;
  };
  const TitleOdd = () => {
    return (
      <box flexDirection="column">
        <text fg={theme().text.muted}>{titleText()}</text>
      </box>
    );
  };
  const hiddenOlder = () => {
    try {
      return Math.max(0, store.userTotal() - props.maxItems);
    } catch {
      return 0;
    }
  };
  const bottomTap = createTapHandler(() => store.backToBottom(liveNodes().map((n) => n.id)));
  const debugLine = createMemo(() =>
    getTimelineDebugLine(props.ctx, props.sessionID, {
      kept: store.nodes().length,
      total: store.userTotal(),
    }),
  );
  const theme = () => props.ctx.theme;
  // 回到底部 hover 高亮：onMouseOver/Out 由宿主输入帧驱动刷屏（与点击同通道）
  const [bottomHover, setBottomHover] = createSignal(false);

  return (
    <Show when={active()}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} onMouseDown={headerTap.onMouseDown} onMouseUp={headerTap.onMouseUp}>
          <text fg={theme().text.base}>{open() ? "▼" : "▶"}</text>
          <Show when={store.paintKey() % 2 === 0}>
            <TitleEven />
          </Show>
          <Show when={store.paintKey() % 2 !== 0}>
            <TitleOdd />
          </Show>
        </box>
        <Show when={open()}>
          <Show when={props.debug}>
            <text fg={theme().text.muted}>{debugLine()}</text>
          </Show>
          <Timeline
            nodes={liveNodes()}
            selectedId={store.selectedId()}
            selectedBackground={theme().background.raised.base}
            borderColor={theme().border.base}
            textColor={theme().text.base}
            timeColor={theme().text.muted}
            maxHeight={maxHeight}
            emptyText={liveEmptyText()}
            onSelect={(messageID) => store.selectAndJump(messageID)}
          />
          <Show when={hiddenOlder() > 0}>
            <text fg={theme().text.muted}>仅显示最近 {props.maxItems} 条 · {hiddenOlder()} 条旧消息已收起</text>
          </Show>
          <Show when={hasNodes()}>
            <box
              flexDirection="row"
              backgroundColor={bottomHover() ? theme().background.raised.base : undefined}
              onMouseDown={bottomTap.onMouseDown}
              onMouseUp={bottomTap.onMouseUp}
              onMouseOver={() => setBottomHover(true)}
              onMouseOut={() => setBottomHover(false)}
            >
              <text fg={bottomHover() ? theme().text.base : theme().text.muted}>
                ⤓ 回到底部
              </text>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  );
}
