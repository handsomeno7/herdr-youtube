import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { appHome, exec, layout, readTextFile, run, props, shared, setShared, theme, openOverlay, nextCommand } from "herdr";

const KEY = "youtube.player";
const player = () => shared(KEY) ?? { running: false, paused: true, queue: [] };
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const result = find(child, id); if (result) return result; }
  return null;
}
function shown() {
  const tree = layout();
  return find(tree, "office-content")?.active === "youtube" && !find(tree, "office")?.hidden && (find(tree, "right")?.size?.px ?? 400) > 100;
}
const time = value => { const n = Math.max(0, Math.floor(value || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; };

async function request(command) {
  const result = await exec("node", [`${appHome()}/mods/youtube/backend.mjs`, "request", JSON.stringify(command)]);
  let reply;
  try { reply = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || "播放器沒有回傳有效資料。"); }
  if (reply.state) setShared(KEY, reply.state);
  if (!reply.ok) throw new Error(reply.error);
  return reply;
}

async function attachTerminal(terminal) {
  if (!terminal || find(layout(), "youtube-frame")?.content?.terminal === terminal) return;
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  const tree = JSON.parse(await readTextFile(path));
  let frame = find(tree, "youtube-frame");
  if (!frame) {
    const container = find(tree, "youtube");
    if (!container) throw new Error("目前版面沒有 YouTube 區塊。");
    frame = { id: "youtube-frame", type: "block", background: "#000000", terminal_padding: [0, 0] };
    container.children.unshift(frame);
  }
  // Preserve current stack choices, including the user's dropdown drawer.
  function keepSelections(node) {
    const current = find(layout(), node.id);
    if (node.type === "stack" && current?.active) node.active = current.active;
    for (const child of node.children ?? []) keepSelections(child);
  }
  keepSelections(tree);
  frame.content = { terminal };
  const result = await exec("herdr-app", ["do", "layout.set", "--layout", JSON.stringify(tree)]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "無法顯示播放器。");
}

export default class YouTube extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "controls";
    this.busy = false;
    this.error = "";
    if (this.role === "tabs") cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "search" || command === "queue") this.library(command);
        cx.notify();
      }
    });
    if (this.role === "library") {
      this.input = InputState.new({ placeholder: "搜尋影片，或貼影片／公開播放清單網址" });
      this.input.on("submit", (_e, cx) => this.search(cx));
      this.input.on("change", (_e, cx) => cx.notify());
      this.input.focus();
    }
    if (this.role === "controls") {
      this.visible = null;
      cx.timer.every(1000, cx => this.refresh(cx));
      this.refresh(cx);
    }
  }

  refresh(cx) {
    if (this.busy || this.refreshing) return;
    const visible = shown();
    if (!visible && this.visible === false) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        const reply = await request(this.visible !== visible ? { action: "visibility", visible } : { action: "status" });
        this.visible = visible;
        if (visible && reply.state?.running) await attachTerminal(reply.state.terminal);
      } catch (error) { this.error = error.message; }
      finally { this.refreshing = false; cx.notify(); }
    });
  }

  act(command, cx) {
    if (this.busy) return;
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await request(command);
        if (result.results) { setShared("youtube.results", result.results); this.section = "search"; }
        if (result.state?.running) await attachTerminal(result.state.terminal);
      } catch (error) { this.error = error.message; }
      finally { this.busy = false; cx.notify(); }
    });
  }

  search(cx) { this.act({ action: "open", input: this.input.value() }, cx); }

  library(section) {
    openOverlay({ mod: "youtube", props: { role: "library", section }, kind: "dialog", width: 620, height: 520 });
  }

  button(id, label, action, enabled = true, active = false) {
    const t = theme();
    return div().id(`yt-${id}`).h(24).px(7).rounded(4).flex().items_center().justify_center().text_size(11)
      .text_color(enabled ? t.foreground : t.dim).when(active, e => e.bg(t.selected))
      .when(enabled, e => e.cursor_pointer().hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => { if (enabled && !this.busy) action(cx); }).child(label);
  }

  tabs() {
    const active = find(layout(), "office-content")?.active ?? "office-scene";
    return h_flex().size_full().px(5).gap(2).items_center()
      .children([["office-scene", "The Office"], ["youtube", "YouTube"]].map(([id, label]) =>
        this.button(`tab-${id}`, label, () => run("layout.select", { stack: "office-content", child: id }), true, active === id)))
      .child(div().flex_1())
      .when(active === "youtube", e => e.child(this.button("search", "搜尋", () => this.library("search")))
        .child(this.button("queue", "清單", () => this.library("queue")))
        .child(this.button("account", player().login ? "登入中" : player().signedIn ? "已登入" : "登入", cx => this.act({ action: "login" }, cx), !player().login)));
  }

  controls() {
    const t = theme(), p = player(), ready = p.running && p.video, index = p.queue?.findIndex(x => x.id === p.video) ?? -1;
    const action = name => cx => this.act({ action: name }, cx);
    return v_flex().size_full().px(6).gap(2).text_color(t.foreground)
      .child(div().h(16).text_size(10).truncate().text_color(this.error || p.error ? t.blocked : t.muted)
        .child(this.error || p.error || (p.login ? "請在專用 Chrome 登入 YouTube，完成後關閉視窗。" : p.title) || "搜尋影片或貼上 YouTube 網址"))
      .child(div().id("yt-seek").h(8).rounded(3).bg(t.raised).cursor_pointer()
        .on_mouse_down("left", (e, cx) => {
          if (!ready || !p.duration || !e.bounds) return;
          const ratio = Math.max(0, Math.min(1, e.local_position.x / e.bounds.width));
          this.act({ action: "seek", value: ratio * p.duration }, cx);
        }).child(div().h(8).rounded(3).bg(t.accent).w(`${Math.min(100, (p.time || 0) / (p.duration || 1) * 100)}%`)))
      .child(h_flex().gap(1).items_center()
        .child(this.button("prev", "上一部", action("previous"), ready && index > 0))
        .child(this.button("play", this.busy ? "處理中" : p.paused ? "播放" : "暫停", action(p.paused ? "play" : "pause"), ready))
        .child(this.button("next", "下一部", action("next"), ready && index >= 0 && index < p.queue.length - 1))
        .child(div().flex_1().text_size(10).text_color(t.dim).child(`${time(p.time)} / ${p.duration ? time(p.duration) : "直播"}`))
        .child(this.button("mute", p.muted ? "靜音中" : "聲音", action("mute"), ready))
        .child(this.button("volume-down", "−", cx => this.act({ action: "volume", value: Math.max(0, (p.volume ?? 50) - 10) }, cx), ready))
        .child(this.button("volume-up", "+", cx => this.act({ action: "volume", value: Math.min(100, (p.volume ?? 50) + 10) }, cx), ready))
        .child(this.button("stop", "關閉", action("shutdown"), p.running)));
  }

  renderLibrary() {
    const t = theme(), p = player(), section = this.section ?? props()?.section ?? "search";
    const items = section === "queue" ? p.queue ?? [] : shared("youtube.results") ?? [];
    return v_flex().size_full().p(14).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(6)
        .child(this.button("results", "搜尋結果", cx => { this.section = "search"; cx.notify(); }, true, section === "search"))
        .child(this.button("playlist", `播放清單 (${p.queue?.length ?? 0})`, cx => { this.section = "queue"; cx.notify(); }, true, section === "queue"))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).child("Esc 關閉")))
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.input).flex_1().h(32).px(8).rounded(5).bg(t.background).text_size(12))
        .child(this.button("submit", this.busy ? "載入中…" : "搜尋／開啟", cx => this.search(cx), !this.busy)))
      .when(Boolean(this.error), e => e.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().id("yt-results").flex_1().min_h(0).overflow_y_scrollbar()
        .when(!items.length, e => e.child(div().p(16).text_size(12).text_color(t.muted).child(section === "queue" ? "貼上公開播放清單網址，即可載入清單。" : "輸入關鍵字搜尋，或貼上影片網址直接播放。")))
        .children(items.map((item, index) => v_flex().id(`yt-item-${index}`).px(8).py(8).gap(3).rounded(5).cursor_pointer()
          .when(item.id === p.video, e => e.bg(t.selected))
          .hover(e => e.bg(t.hover)).on_click((_e, cx) => {
            if (section === "queue") this.act({ action: "select", index }, cx);
            else this.act({ action: "open", input: item.type === "playlist" ? `https://www.youtube.com/playlist?list=${item.id}` : `https://www.youtube.com/watch?v=${item.id}` }, cx);
          })
          .child(div().text_size(12).child(`${item.type === "playlist" ? "[播放清單] " : ""}${item.title}`))
          .child(div().text_size(10).text_color(t.muted).child([item.by, item.duration].filter(Boolean).join(" · "))))))
      .when(section === "queue" && items.length >= 100, e => e.child(div().text_size(10).text_color(t.dim).child("目前顯示 YouTube 首次載入的清單項目。")));
  }

  render() {
    if (this.role === "tabs") return this.tabs();
    if (this.role === "library") return this.renderLibrary();
    if (this.role === "empty") return div().size_full().flex().items_center().justify_center().bg("#000000").text_color(theme().muted).text_size(12).child("從上方搜尋影片開始播放");
    return this.controls();
  }

  async close() {
    if (this.role === "controls" && this.visible !== null) await request({ action: "shutdown" });
  }
}
