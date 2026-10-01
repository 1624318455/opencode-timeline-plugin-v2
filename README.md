# opencode-timeline-plugin-v2

Conversation history node viewer for the **OpenCode V2** TUI (sidebar timeline).

- V2-only port of `@memef1f1y/opencode-timeline-plugin` (V1).
- The V1 package is untouched and keeps working for V1 users; this package targets `opencode@^2`.
- Plugin id stays `timeline.viewer`; jump memory moved from V1 `kv` to V2 `ctx.storage`
  (fresh namespace, V1 memory is not carried over).

## What it does

Sidebar block listing the session's user messages (newest on top, 30-char summaries,
`HH:MM` timestamps). Mouse only: click a row to jump the transcript to that message,
click the header to collapse/expand, click `⤓ 回到底部` to scroll back to the bottom.
No keyboard shortcuts are registered, so the input box is never affected.

History is fetched from the server (`message.list` with `type: "user"`, newest-first
paging), so the panel shows all user messages up to `maxItems` immediately — it does
not depend on how far the main transcript has been scrolled (the native `/timeline`
and the TUI's local message window only see recently loaded messages).

Rendering model: the V2 host does not schedule frames for plugin-owned reactive
updates, so pushing updates (`requestRender`, store writes) leaves the panel frozen
at its mount-time values. Instead, the entry re-creates the slot claim whenever the
content signature changes — a fresh mount always reads fresh values. Unsubscribe and
re-subscribe happen in the same tick (one frame, no visible flicker), and a signature
guard keeps it convergent (mount → fetch → one remount → steady).

 known issue during development: each hot reload re-runs `setup` and adds a
claim while the previous generation's claim may stay orphaned, so the panel can
appear duplicated while iterating — restart the TUI once for a single instance.
In steady use (no file changes) remounts reuse live handles and stay single.

## Install (local path)

In `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    {
      "package": "D:/Work/ForAI/opencode-timeline-plugin-v2/src/tui.tsx",
      "options": { "maxItems": 50 }
    }
  ]
}
```

Options: `maxItems` (default 50, max user messages shown), `debug` (default false,
shows a `dbg …` snapshot line for troubleshooting).

Restart the TUI. The block appears at the end of the sidebar as `Timeline N`.

## Publish layout

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx"
  }
}
```

`./tui` is the CLI entry (auto-loaded); `.` is the minimal server entry required
beside it. No build step — OpenCode loads the TypeScript sources directly.

## Dev

```sh
npm install
npm run typecheck
```

Port notes: V1 `api.state.session.messages()` → `ctx.data.session.message.list()`
(V2 messages carry inline `text`, no parts lookup needed); V1 `api.event.on` →
`ctx.data.listen` + trailing throttle + `message.sync()`; V1 `slots.register({
sidebar_content })` → `ctx.ui.slot({ append: "sidebar.content" })`; V1 `api.kv` →
`ctx.storage.store`. Keyboard navigation from V1 was intentionally dropped
(it hijacked the input box); interaction is mouse-only.
