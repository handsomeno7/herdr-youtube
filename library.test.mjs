import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('./main.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default class YouTube', 'globalThis.YouTube = class YouTube');

// Keep the event handlers from the real renderer; the native host owns layout.
function setup(section = 'search', count = 19, search = null) {
  const nodes = new Map(), closed = [], calls = [], events = {};
  const element = () => {
    const node = { children: [] };
    const proxy = new Proxy(node, { get(target, key) {
      if (key === 'child') return child => { target.children.push(child); return proxy; };
      if (key === 'children') return children => { target.children.push(...children); return proxy; };
      if (key === 'when') return (condition, fn) => condition ? fn(proxy) : proxy;
      if (key === 'id') return id => { nodes.set(id, target); return proxy; };
      return (...args) => { target[key] = args; return proxy; };
    } });
    return proxy;
  };
  const items = Array.from({ length: count }, (_, i) => ({ id: `video-${i}`, title: `Video ${i}`, type: 'video', thumbnailFile: 'mods/youtube/.cache/thumbnails/test.jpg' }));
  const store = new Map([['youtube.player', { queue: items }], ['youtube.results', items], ['youtube.search', search]]);
  const replies = [], requests = [], pending = [];
  const input = { on: (name, fn) => { events[name] = fn; }, focus() {}, value: () => 'new search' };
  const context = vm.createContext({
    View: class {}, div: element, h_flex: element, v_flex: element, svg: element, image: element,
    appHome: () => '/test/herdr-app',
    InputState: { new: () => input }, Input: { new: element },
    props: () => ({ role: 'library', section, overlay: 'search-dialog' }),
    shared: key => store.get(key), setShared: (key, value) => store.set(key, value),
    exec: async (_command, args) => {
      requests.push(JSON.parse(args.at(-1)));
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return { stdout: JSON.stringify(reply) };
    },
    theme: () => ({}), closeOverlay: id => closed.push(id),
  });
  vm.runInContext(source, context);
  const library = new context.YouTube();
  const cx = { focus_handle() {}, timer: { after() {} }, notify() {}, stop_propagation() { calls.push('stopped'); } };
  cx.spawn = fn => pending.push(fn(cx));
  library.init({}, cx);
  const realAct = library.act.bind(library);
  library.act = command => calls.push(JSON.parse(JSON.stringify(command)));
  const render = () => { nodes.clear(); library.renderLibrary(); };
  render();
  return { library, render, nodes, calls, closed, events, cx, store, replies, requests, pending, realAct };
}

test('Escape and Close dismiss only this dialog, including during a request', () => {
  const s = setup();
  s.library.busy = true;
  s.nodes.get('yt-library').on_key_down[0]({ key: 'escape' }, s.cx);
  s.nodes.get('yt-dismiss').on_click[0]({}, s.cx);
  assert.deepEqual(s.closed, ['search-dialog', 'search-dialog']);
  assert.ok(s.calls.includes('stopped'));
});

test('pagination preserves queue indices and stops at either end', () => {
  const s = setup('queue');
  s.nodes.get('yt-page-prev').on_click[0]({}, s.cx);
  assert.equal(s.library.page, 0);
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  s.render();
  assert.ok(!s.nodes.has('yt-item-0'));
  s.nodes.get('yt-item-8').on_click[0]({}, s.cx);
  assert.deepEqual(s.calls, [{ action: 'select', index: 8 }]);
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  s.render();
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  assert.equal(s.library.page, 2);
  assert.ok(s.nodes.has('yt-item-18'));
  assert.ok(!s.nodes.has('yt-item-19'));
  s.nodes.get('yt-results').on_click[0]({}, s.cx);
  assert.equal(s.library.page, 0);
});

test('search result selection and input submit use the existing playback path', () => {
  const s = setup();
  s.nodes.get('yt-item-0').on_click[0]({}, s.cx);
  s.events.submit({}, s.cx);
  assert.deepEqual(s.calls, [
    { action: 'open', input: 'https://www.youtube.com/watch?v=video-0' },
    { action: 'open', input: 'new search' },
  ]);
  assert.doesNotThrow(() => setup('search', 0));
});

test('last search page loads the next batch using the stored query', async () => {
  const s = setup('search', 40, { query: 'john mayer', continuation: 'first-cursor' });
  s.library.page = 4;
  s.library.act = s.realAct;
  s.replies.push({ ok: true, results: [
    { id: 'video-39', type: 'video', title: 'Duplicate' },
    { id: 'new-video', type: 'video', title: 'New result' },
  ], search: { query: 'john mayer', continuation: 'next-cursor' } });
  s.render();
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  await Promise.all(s.pending);
  assert.equal(s.requests.length, 1, 'busy button must not send a duplicate request');
  assert.deepEqual(s.requests[0], { action: 'more', input: 'john mayer', continuation: 'first-cursor' });
  assert.equal(s.store.get('youtube.results').length, 41);
  assert.equal(s.store.get('youtube.search').continuation, 'next-cursor');
  assert.equal(s.library.page, 5);
  s.render();
  assert.ok(s.nodes.has('yt-item-40'));
});

test('failed continuation keeps results and cursor available for retry', async () => {
  const s = setup('search', 40, { query: 'john mayer', continuation: 'retry-cursor' });
  s.library.page = 4;
  s.library.act = s.realAct;
  s.replies.push({ ok: false, error: 'Could not load more results. Try again.' });
  s.render();
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  await Promise.all(s.pending);
  assert.equal(s.store.get('youtube.results').length, 40);
  assert.equal(s.store.get('youtube.search').continuation, 'retry-cursor');
  assert.equal(s.library.page, 4);
  assert.equal(s.library.busy, false);
  assert.match(s.library.error, /Try again/);
  s.replies.push({ ok: true, results: [], search: { query: 'john mayer', continuation: null } });
  s.render();
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  await Promise.all(s.pending);
  assert.equal(s.store.get('youtube.search').continuation, null);
  assert.equal(s.library.page, 4);
  s.render();
  s.nodes.get('yt-page-next').on_click[0]({}, s.cx);
  assert.equal(s.requests.length, 2, 'the actual end disables further requests');
});

test('partial pages keep newly appended results visible, and new searches reset pagination', async () => {
  const s = setup('search', 19, { query: 'john mayer', continuation: 'cursor' });
  s.library.page = 2;
  s.replies.push({ ok: true, results: [{ id: 'new-video', type: 'video' }], search: { query: 'john mayer', continuation: 'next' } });
  s.realAct({ action: 'more' }, s.cx);
  await Promise.all(s.pending);
  assert.equal(s.library.page, 2, 'new rows fill the partial page before advancing');
  s.render();
  assert.ok(s.nodes.has('yt-item-19'));
  s.replies.push({ ok: true, results: [{ id: 'other-video', type: 'video' }], search: { query: 'other artist', continuation: null } });
  s.realAct({ action: 'open', input: 'other artist' }, s.cx);
  await Promise.all(s.pending);
  assert.equal(s.library.page, 0);
  assert.equal(s.store.get('youtube.results').length, 1);
  assert.equal(s.store.get('youtube.search').query, 'other artist');
});
