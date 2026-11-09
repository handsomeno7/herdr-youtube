import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { appHome, exec, layout, readTextFile, run, props, shared, setShared, theme, openOverlay, closeOverlay, nextCommand } from "herdr";

const KEY = "youtube.player";
const PAGE_SIZE = 8;
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
const RED = "#ff0033";
const icon = name => svg(`mods/youtube/icons/${name}.svg`);
const time = value => { const n = Math.max(0, Math.floor(value || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; };

async function request(command) {
  const result = await exec("node", [`${appHome()}/mods/youtube/backend.mjs`, "request", JSON.stringify(command)]);
  let reply;
  try { reply = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || "The player returned invalid data."); }
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
    if (!container) throw new Error("This layout has no YouTube panel.");
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
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Could not show the player.");
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
      this.page = 0;
      this.handle = cx.focus_handle();
      this.input = InputState.new({ placeholder: "Search videos or paste a video / public playlist URL" });
      this.input.on("submit", (_e, cx) => this.search(cx));
      this.input.on("change", (_e, cx) => cx.notify());
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
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
        if (this.refreshFailed) { this.error = ""; this.refreshFailed = false; }
        if (visible && reply.state?.running) await attachTerminal(reply.state.terminal);
      } catch (error) { this.error = error.message; this.refreshFailed = true; }
      finally { this.refreshing = false; cx.notify(); }
    });
  }

  act(command, cx) {
    if (this.busy) return;
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await request(command);
        if (result.results) {
          const previous = command.action === "more" ? shared("youtube.results") ?? [] : [];
          const items = [...new Map([...previous, ...result.results].map(item => [`${item.type}:${item.id}`, item])).values()];
          setShared("youtube.results", items);
          setShared("youtube.search", result.search);
          this.section = "search";
          this.page = command.action === "more" ? Math.min(Math.floor(previous.length / PAGE_SIZE), Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1)) : 0;
        }
        if (result.state?.running) await attachTerminal(result.state.terminal);
      } catch (error) { this.error = error.message; }
      finally { this.busy = false; cx.notify(); }
    });
  }

  search(cx) { this.act({ action: "open", input: this.input.value() }, cx); }

  library(section) {
    openOverlay({ mod: "youtube", props: { role: "library", section }, kind: "dialog", frame: "none", width: 620, height: 520 });
  }

  button(id, label, action, enabled = true, active = false) {
    const t = theme();
    return div().id(`yt-${id}`).h(24).px(7).rounded(4).flex().items_center().justify_center().text_size(11)
      .text_color(enabled ? t.foreground : t.dim).when(active, e => e.bg(t.selected))
      .when(enabled, e => e.cursor_pointer().hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => { if (enabled && !this.busy) action(cx); }).child(label);
  }

  iconButton(id, name, tip, action, enabled = true, size = 18) {
    const t = theme();
    return div().id(`yt-${id}`).w(28).h(28).flex_none().rounded_full().flex().items_center().justify_center()
      .text_color(enabled ? t.foreground : t.dim).tooltip(tip)
      .when(enabled, e => e.cursor_pointer().hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => { if (enabled && (!this.busy || id === "dismiss")) action(cx); }).child(icon(name).size(size));
  }

  tabs() {
    const active = find(layout(), "office-content")?.active ?? "office-scene";
    return h_flex().size_full().px(5).gap(2).items_center()
      .children([["office-scene", "The Office"], ["youtube", "YouTube"]].map(([id, label]) =>
        this.button(`tab-${id}`, label, () => run("layout.select", { stack: "office-content", child: id }), true, active === id)))
      .child(div().flex_1())
      .when(active === "youtube", e => e.child(this.iconButton("search", "search", "Search", () => this.library("search"), true, 16))
        .child(this.iconButton("queue", "queue", "Queue", () => this.library("queue"), true, 16))
        .child(this.iconButton("account", "account", player().login ? "Signing in" : player().signedIn ? "Signed in to YouTube" : "Sign in to YouTube", cx => this.act({ action: "login" }, cx), !player().login, 16)));
  }

  controls() {
    const t = theme(), p = player(), ready = p.running && p.video, index = p.queue?.findIndex(x => x.id === p.video) ?? -1;
    const action = name => cx => this.act({ action: name }, cx);
    const message = this.error || p.error, volume = p.muted ? 0 : p.volume ?? 50;
    // Clickable strip taller than the bar it draws, like YouTube's progress bar.
    const bar = (id, width, percent, color, pick) => div().id(id).w(width).h(8).flex_none().flex().items_center().cursor_pointer()
      .on_mouse_down("left", (e, cx) => {
        if (!ready || !e.bounds) return;
        pick(Math.max(0, Math.min(1, e.local_position.x / e.bounds.width)), cx);
      }).child(div().w_full().h(3).rounded(2).bg(t.raised).child(div().h(3).rounded(2).bg(color).w(`${Math.min(100, percent)}%`)));
    return v_flex().size_full().text_color(t.foreground)
      .child(bar("yt-seek", "100%", (p.time || 0) / (p.duration || 1) * 100, RED, (ratio, cx) => {
        if (p.duration) this.act({ action: "seek", value: ratio * p.duration }, cx);
      }))
      .child(h_flex().flex_1().px(4).gap(1).items_center()
        .child(this.iconButton("prev", "previous", "Previous video", action("previous"), ready && index > 0))
        .child(this.iconButton("play", p.paused ? "play" : "pause", p.paused ? "Play" : "Pause", action(p.paused ? "play" : "pause"), ready, 20))
        .child(this.iconButton("next", "next", "Next video", action("next"), ready && index >= 0 && index < p.queue.length - 1))
        .child(this.iconButton("mute", p.muted ? "muted" : "volume", p.muted ? "Unmute" : "Mute", action("mute"), ready))
        .child(bar("yt-volume", 56, volume, t.foreground, (ratio, cx) => this.act({ action: "volume", value: Math.round(ratio * 100) }, cx)))
        .child(div().ml(8).flex_none().text_size(11).text_color(t.muted).child(`${time(p.time)} / ${p.duration ? time(p.duration) : "LIVE"}`))
        .child(div().flex_1().min_w(0).px(6).text_size(11).truncate().text_color(message ? t.blocked : t.dim)
          .child(message || (p.login ? "Sign in to YouTube in the dedicated Chrome window, then close it." : p.title) || "Search videos or paste a YouTube URL"))
        .child(this.iconButton("stop", "close", "Stop player", action("shutdown"), p.running, 16)));
  }

  renderLibrary() {
    const t = theme(), p = player(), section = this.section ?? props()?.section ?? "search";
    const items = section === "queue" ? p.queue ?? [] : shared("youtube.results") ?? [];
    const search = shared("youtube.search"), hasMore = section === "search" && Boolean(search?.continuation);
    const pageSize = PAGE_SIZE, pages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(this.page, pages - 1), start = page * pageSize;
    const changeSection = section => cx => { this.section = section; this.page = 0; cx.notify(); };
    const close = () => closeOverlay(props().overlay);
    return v_flex().id("yt-library").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .size_full().min_h(0).p(14).gap(10).rounded(12).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().items_center().gap(6)
        .child(this.button("results", "Search results", changeSection("search"), true, section === "search"))
        .child(this.button("playlist", `Queue (${p.queue?.length ?? 0})`, changeSection("queue"), true, section === "queue"))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).child("Esc to close"))
        .child(this.iconButton("dismiss", "close", "Close", close)))
      .child(h_flex().flex_none().gap(6).items_center()
        .child(Input.new(this.input).flex_1().h(32).px(8).rounded(5).bg(t.background).text_size(12))
        .child(this.button("submit", this.busy ? "Loading…" : "Search / Open", cx => this.search(cx), !this.busy)))
      .when(Boolean(this.error), e => e.child(div().flex_none().text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().id(`yt-results-${section}-${page}`).flex_1().min_h(0).overflow_y_scrollbar()
        .when(!items.length, e => e.child(div().p(16).text_size(12).text_color(t.muted).child(section === "queue" ? "Paste a public playlist URL to load its videos." : "Search for videos, or paste a video URL to play it.")))
        .children(items.slice(start, start + pageSize).map((item, offset) => h_flex().id(`yt-item-${start + offset}`).px(8).py(8).gap(10).rounded(5).cursor_pointer()
          .when(item.id === p.video, e => e.bg(t.selected))
          .hover(e => e.bg(t.hover)).on_click((_e, cx) => {
            if (this.busy) return;
            if (section === "queue") this.act({ action: "select", index: start + offset }, cx);
            else this.act({ action: "open", input: item.type === "playlist" ? `https://www.youtube.com/playlist?list=${item.id}` : `https://www.youtube.com/watch?v=${item.id}` }, cx);
          })
          .child(div().w(128).h(72).flex_none().rounded(5).overflow_hidden().bg(t.background).flex().items_center().justify_center()
            .child(item.thumbnailFile ? image(item.thumbnailFile).w(128).h(72) : icon("play").size(24)))
          .child(v_flex().flex_1().min_w(0).gap(5)
            .child(div().text_size(12).child(`${item.type === "playlist" ? "[Playlist] " : ""}${item.title}`))
            .child(div().text_size(10).text_color(t.muted).child([item.by, item.duration].filter(Boolean).join(" · ")))))))
      .child(h_flex().flex_none().items_center().gap(6)
        .child(div().flex_1().text_size(10).text_color(t.dim).child(`${items.length} results${hasMore ? " · More available" : section === "search" && search ? " · End of results" : ""}`))
        .child(this.button("page-prev", "Previous", cx => { this.page = page - 1; cx.notify(); }, page > 0))
        .child(div().text_size(11).child(hasMore ? `Page ${page + 1}` : `${page + 1} / ${pages}`))
        .child(this.button("page-next", this.busy ? "Loading…" : page + 1 >= pages && hasMore ? "Load more" : "Next", cx => {
          if (page + 1 < pages) { this.page = page + 1; cx.notify(); }
          else this.act({ action: "more", input: search.query, continuation: search.continuation }, cx);
        }, page + 1 < pages || hasMore)));
  }

  render() {
    if (this.role === "tabs") return this.tabs();
    if (this.role === "library") return this.renderLibrary();
    if (this.role === "empty") return div().size_full().flex().items_center().justify_center().bg("#000000").text_color(theme().muted).text_size(12).child("Search above to play a video");
    return this.controls();
  }

  async close() {
    if (this.role === "controls" && this.visible !== null) await request({ action: "shutdown" });
  }
}
