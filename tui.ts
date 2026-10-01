// V2 发现机制兼容垫片：若宿主按“包目录下 tui.ts”字面路径加载 CLI 入口，
// 则走这里再转到真正的 ./src/tui.tsx；若宿主走 package.json exports["./tui"]，
// 则本文件被忽略。稳定后若确认无用可删除。
export { default } from "./src/tui";
export * from "./src/tui";
