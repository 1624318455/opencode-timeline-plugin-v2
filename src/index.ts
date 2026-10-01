import { Plugin } from "@opencode/plugin";

/**
 * 服务端入口（V2 包按指南要求与 ./tui 并存）。
 * Timeline 是纯 TUI 侧边栏插件，服务端无逻辑，仅注册 id。
 */
export default Plugin.define({
  id: "timeline.viewer",
  async setup() {},
});
