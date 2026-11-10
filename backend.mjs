import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { userInfo, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseInput, samePage, extractItems, extractSearchPage, extractPanel, framePacket, stillPlan } from './model.mjs';

const runtime = `/tmp/herdr-youtube-${userInfo().uid}`;
const socketPath = `${runtime}/control.sock`;
const self = fileURLToPath(import.meta.url);
const profile = `${homedir()}/.local/share/herdr-youtube/chrome`;
function browserEnv() {
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${userInfo().uid}` };
  env.PULSE_SERVER ||= `unix:${env.XDG_RUNTIME_DIR}/pulse/native`;
  env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  env.XDG_CURRENT_DESKTOP ||= 'GNOME';
  return env;
}

function request(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setTimeout(25000, () => socket.destroy(new Error('The player response timed out.')));
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { socket.end(); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } } });
  });
}

if (process.argv[2] === 'request') {
  try {
    const command = JSON.parse(process.argv[3] || '{}');
    let result;
    try { result = await request(command); } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (['status', 'visibility', 'shutdown'].includes(command.action)) result = { ok: true, state: { running: false, queue: [] } };
      else {
        const start = spawnSync('hc', ['run', '--bg', '--outlive-parent', '--no-notify', '--name', 'herdr-youtube', 'node', self, 'serve'], { encoding: 'utf8' });
        for (let i = 0; i < 80; i++) {
          try { result = await request(command); break; } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
          await delay(100);
        }
        if (!result) throw new Error(start.status !== 0 ? start.stderr || start.stdout : 'The player did not start in time.');
      }
    }
    console.log(JSON.stringify(result));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
} else if (process.argv[2] === 'serve') {
  await serve();
}

async function connectPage(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map(), listeners = new Map();
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data), task = pending.get(msg.id);
    if (msg.method) { listeners.get(msg.method)?.(msg.params); return; }
    if (!task) return;
    clearTimeout(task.timer); pending.delete(msg.id);
    msg.error ? task.reject(new Error(msg.error.message)) : task.resolve(msg.result);
  });
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('The browser connection closed.')); } pending.clear(); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Browser operation timed out: ${method}`)); }, 20000);
    pending.set(key, { resolve, reject, timer }); ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression, userGesture = false) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
    return r.result.value;
  };
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 640, height: 360, deviceScaleFactor: 1, mobile: false });
  return { call, evaluate, on: (method, handler) => listeners.set(method, handler), close: () => ws.close() };
}

async function serve() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  try { await request({ action: 'status' }); throw new Error('The player is already running.'); } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
  let chrome, player, discovery, port, loading = false, visible = true;
  let cell = { width: 8, height: 17 };
  let queue = [], refilled = null;
  let state = { running: false, title: '', paused: true, muted: false, volume: 50, time: 0, duration: 0, queue, list: null, terminal: process.env.HC_TERMINAL_ID, error: '' };
  let frameCount = 0, frameStart = Date.now();
  // Chrome pushes frames while playing; only the newest waiting frame is drawn.
  let casting = false, latestFrame = null, writing = false, frameIndex = 0, still = null;
  const placement = () => {
    const width = (process.stdout.columns || 50), height = (process.stdout.rows || 14);
    const cols = Math.max(1, Math.min(width, Math.floor(height * cell.height * 16 / 9 / cell.width)));
    const rows = Math.max(1, Math.min(height, Math.round(cols * cell.width * 9 / 16 / cell.height)));
    return { cols, rows, top: Math.floor((height - rows) / 2) + 1, left: Math.floor((width - cols) / 2) + 1 };
  };
  const drawFrame = async data => {
    const { cols, top, left } = placement();
    if (!process.stdout.write(framePacket(data, frameIndex++, cols, top, left))) await new Promise(resolve => process.stdout.once('drain', resolve));
    frameCount++;
  };
  async function pumpFrames() {
    if (writing) return;
    writing = true;
    try { while (latestFrame) { const data = latestFrame; latestFrame = null; await drawFrame(data); } }
    finally { writing = false; }
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let inputBuffer = '';
  process.stdin.on('data', data => {
    inputBuffer = (inputBuffer + data).slice(-200);
    const m = /\x1b\[6;(\d+);(\d+)t/.exec(inputBuffer);
    if (m) { cell = { height: Number(m[1]), width: Number(m[2]) }; inputBuffer = ''; }
  });
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l\x1b[16t');
  // hc starts without a viewer; query the real cell size again on attach/resize.
  process.stdout.on('resize', () => process.stdout.write('\x1b[16t'));
  const stopBrowser = async () => {
    const browser = chrome;
    player?.close(); discovery?.close(); player = discovery = null;
    chrome = null;
    queue = []; state = { ...state, running: false, login: false, paused: true, title: '', video: null, queue, list: null, time: 0, duration: 0, error: '' };
    process.stdout.write('\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J\x1b[H');
    if (browser && browser.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => browser.kill('SIGKILL'), 2000);
      browser.once('exit', () => { clearTimeout(timer); resolve(); });
      browser.kill('SIGTERM');
    });
  };
  async function ensureBrowser() {
    if (state.login) throw new Error('Finish signing in and close the dedicated Chrome window first.');
    if (player) return;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await unlink(`${profile}/DevToolsActivePort`).catch(() => {});
    let errors = '';
    chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--password-store=gnome-libsecret', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: browserEnv() });
    chrome.stderr.on('data', chunk => { errors = (errors + chunk).slice(-3000); });
    for (let i = 0; i < 100; i++) {
      if (chrome.exitCode !== null) throw new Error(`Chrome failed to start: ${errors}`);
      try { port = Number((await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0]); break; } catch {}
      await delay(100);
    }
    if (!port) throw new Error('Chrome did not start in time.');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    player = await connectPage(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    const page = player;
    page.on('Page.screencastFrame', ({ data, sessionId }) => {
      page.call('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (page !== player || !casting) return;
      latestFrame = data;
      pumpFrames();
    });
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    discovery = await connectPage(tab.webSocketDebuggerUrl);
    state.running = true;
    const browser = chrome;
    chrome.once('exit', () => { if (chrome !== browser) return; player?.close(); discovery?.close(); player = discovery = null; state.running = false; chrome = null; });
  }
  async function cacheThumbnails(items) {
    const cache = new URL('./.cache/thumbnails/', import.meta.url);
    await mkdir(cache, { recursive: true });
    await Promise.all(items.map(async item => {
      if (!item.thumbnail) return;
      const name = `${item.type}-${item.id}.jpg`, file = new URL(name, cache);
      try {
        try { await access(file); } catch {
          const response = await fetch(item.thumbnail, { signal: AbortSignal.timeout(3000) });
          if (!response.ok) return;
          await writeFile(file, Buffer.from(await response.arrayBuffer()));
        }
        item.thumbnailFile = `mods/youtube/.cache/thumbnails/${name}`;
      } catch { /* A missing thumbnail must not block search or playback. */ }
    }));
  }
  // A Mix has no /playlist page, so its videos come from the watch page.
  async function mixQueue(list, video) {
    const url = `https://www.youtube.com/watch?${video ? `v=${video}&` : ''}list=${list}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`YouTube returned ${response.status} for this Mix.`);
    const items = extractPanel(await response.text());
    await cacheThumbnails(items);
    return items;
  }
  async function pageItems(url) {
    await discovery.call('Page.navigate', { url });
    // Wait for this navigation's data, rather than accepting the previous page.
    for (let i = 0; i < 60; i++) {
      const r = await discovery.evaluate(`JSON.stringify({url:location.href,ready:document.readyState,data:window.ytInitialData||null,text:document.body?.innerText.slice(0,1000)||''})`);
      const page = JSON.parse(r);
      if (samePage(page.url, url) && page.ready !== 'loading') {
        const items = extractItems(page.data);
        if (items.length) {
          await cacheThumbnails(items);
          await player.call('Page.bringToFront');
          return { items, continuation: url.includes('/results?') ? extractSearchPage(page.data).continuation : null };
        }
        if (/Sign in to confirm|確認您不是機器人|This playlist does not exist|這個播放清單不存在|private playlist|私人播放清單/i.test(page.text)) throw new Error('YouTube requires sign-in, or this playlist is unavailable.');
      }
      await delay(250);
    }
    throw new Error('No results found, or the YouTube page could not be read.');
  }
  async function moreSearch(command) {
    const parsed = parseInput(command.input), continuation = command.continuation;
    if (!parsed.query || typeof continuation !== 'string' || !continuation.length || continuation.length > 20000) throw new Error('Invalid search cursor. Search again.');
    await ensureBrowser();
    if (!await discovery.evaluate(`Boolean(window.ytcfg?.get('INNERTUBE_CONTEXT'))`)) {
      await pageItems(`https://www.youtube.com/results?search_query=${encodeURIComponent(parsed.query)}`);
    }
    const data = await discovery.evaluate(`(async () => {
      const response = await fetch('/youtubei/v1/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12000),
        body: JSON.stringify({ context: window.ytcfg.get('INNERTUBE_CONTEXT'), continuation: ${JSON.stringify(continuation)} })
      });
      if (!response.ok) throw new Error('Could not load more results. Try again.');
      return await response.json();
    })()`);
    const next = extractSearchPage(data);
    if (next.continuation === continuation) throw new Error('YouTube did not advance the search. Try again.');
    await cacheThumbnails(next.items);
    return { state, results: next.items, search: { query: parsed.query, continuation: next.continuation } };
  }
  async function load(video, list) {
    const parsed = parseInput(`https://www.youtube.com/watch?v=${video}${list ? `&list=${list}` : ''}`);
    loading = true;
    state.error = '';
    try {
      await player.call('Page.navigate', { url: `https://www.youtube.com/watch?v=${parsed.video}${parsed.list ? `&list=${parsed.list}` : ''}` });
      await player.call('Page.bringToFront');
      let ready = false;
      for (let i = 0; i < 80; i++) {
        ready = await player.evaluate(`location.href.includes(${JSON.stringify(parsed.video)}) && document.readyState==='complete' && !!document.querySelector('video')?.currentSrc && !!document.querySelector('#movie_player')`);
        if (ready) break;
        await delay(250);
      }
      if (!ready) throw new Error('The video did not load in time.');
      await player.evaluate(`(() => {
        const style=document.createElement('style'); style.id='herdr-player-style';
        style.textContent='html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:black!important} #movie_player{position:fixed!important;inset:0!important;margin:0!important;padding:0!important;background:black!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important} video{width:100vw!important;height:100vh!important;left:0!important;top:0!important;object-fit:contain!important;background:black!important} .ytp-chrome-top,.ytp-chrome-bottom,.ytp-gradient-top,.ytp-gradient-bottom{opacity:0!important;pointer-events:none!important}';
        document.head.appendChild(style); const v=document.querySelector('video'); v.volume=${state.volume / 100};v.muted=${state.muted};v.play().catch(()=>{});return true;
      })()`, true);
      state.video = video; state.list = list || null; state.paused = false;
      visible = true;
    } finally { loading = false; }
  }
  async function updateState() {
    if (!player || loading) return;
    const result = await player.evaluate(`JSON.stringify((()=>{const v=document.querySelector('video'),p=document.querySelector('#movie_player'),u=new URL(location.href);return {video:u.searchParams.get('v'),title:document.title.replace(/ - YouTube$/,'').replace(/^\\(\\d+\\) /,''),signedIn:window.ytcfg?.get('LOGGED_IN')===true,time:v?.currentTime||0,duration:Number.isFinite(v?.duration)?v.duration:0,paused:v?.paused??true,muted:v?.muted??false,volume:Math.round((v?.volume??.5)*100),error:document.querySelector('.ytp-error-content-wrap-reason')?.innerText||v?.error?.message||'',ad:!!p?.classList.contains('ad-showing')}})())`);
    Object.assign(state, JSON.parse(result));
    // YouTube keeps a Mix going past the videos we read; fetch the next batch once per video.
    if (state.list?.startsWith('RD') && state.video && refilled !== state.video && !queue.some(x => x.id === state.video)) {
      const video = refilled = state.video, list = state.list;
      mixQueue(list, video).then(items => { if (items.length && state.video === video) { queue = items; state.queue = queue; } }).catch(() => {});
    }
  }
  async function handle(command) {
    const { action } = command;
    if (action === 'status') return { state: { ...state, fps: Number((frameCount / Math.max(1, (Date.now() - frameStart) / 1000)).toFixed(1)) } };
    if (action === 'shutdown') { await stopBrowser(); return { state }; }
    if (action === 'login') {
      if (state.login) return { state };
      const resume = { ...state }, savedQueue = queue;
      await stopBrowser();
      await mkdir(profile, { recursive: true, mode: 0o700 });
      state.login = true;
      const env = browserEnv(); env.DISPLAY ||= ':0';
      const browser = spawn('/usr/bin/google-chrome', ['--no-first-run', '--no-default-browser-check', '--password-store=gnome-libsecret', `--user-data-dir=${profile}`, '--new-window', 'https://www.youtube.com/'], { stdio: ['ignore', 'ignore', 'pipe'], env });
      chrome = browser;
      let errors = '';
      browser.stderr.on('data', data => { errors = (errors + data).slice(-1500); });
      browser.once('exit', code => {
        if (chrome !== browser) return;
        chrome = null; state.login = false;
        if (code !== 0) { state.error = `Could not open the sign-in window: ${errors}`; return; }
        serial = serial.then(async () => {
          try {
            await ensureBrowser();
            queue = savedQueue; state.queue = queue;
            if (resume.video) { await load(resume.video, resume.list); await player.evaluate(`document.querySelector('video')?.pause()`); }
            else await player.call('Page.navigate', { url: 'https://www.youtube.com/' });
            await updateState();
          } catch (error) { state.error = error.message; }
        });
      });
      await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', error => { state.login = false; chrome = null; reject(error); }); });
      return { state };
    }
    if (action === 'visibility') {
      if (typeof command.visible !== 'boolean') throw new Error('Invalid visibility value.');
      visible = command.visible;
      if (!visible && player) await player.evaluate(`document.querySelector('video')?.pause()`);
      await updateState(); return { state };
    }
    if (action === 'more') return await moreSearch(command);
    if (action === 'search' || action === 'open') {
      const parsed = parseInput(command.input);
      await ensureBrowser();
      if (parsed.query) {
        const page = await pageItems(`https://www.youtube.com/results?search_query=${encodeURIComponent(parsed.query)}`);
        return { state, results: page.items, search: { query: parsed.query, continuation: page.continuation } };
      }
      if (parsed.list?.startsWith('RD')) {
        queue = await mixQueue(parsed.list, parsed.video);
        if (!queue.length) throw new Error('Could not read this Mix. Try again.');
        state.queue = queue;
        await load(parsed.video || queue[0].id, parsed.list);
      } else if (parsed.list) {
        queue = (await pageItems(`https://www.youtube.com/playlist?list=${parsed.list}`)).items.filter(x => x.type === 'video');
        state.queue = queue;
        await load(parsed.video || queue[0]?.id, parsed.list);
      } else {
        // A single video plays on as a Mix radio, like YouTube's own autoplay.
        const list = `RD${parsed.video}`;
        queue = await mixQueue(list, parsed.video).catch(() => []);
        state.queue = queue;
        await load(parsed.video, queue.length ? list : undefined);
      }
      await updateState(); return { state };
    }
    if (!player) throw new Error('Select a video first.');
    if (action === 'play' || action === 'pause') await player.evaluate(action === 'play' ? `(()=>{document.querySelector('video').play().catch(()=>{});return true})()` : `document.querySelector('video').pause()`, true);
    else if (action === 'mute') await player.evaluate(`(()=>{const v=document.querySelector('video');v.muted=!v.muted})()`, true);
    else if (action === 'volume' || action === 'seek') {
      const value = command.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (action === 'volume' ? 100 : state.duration)) throw new Error('The control value is out of range.');
      await player.evaluate(action === 'volume' ? `(()=>{const v=document.querySelector('video');v.volume=${value / 100};v.muted=false})()` : `document.querySelector('video').currentTime=${value}`, true);
    } else if (action === 'next' || action === 'previous') {
      await updateState();
      const index = queue.findIndex(x => x.id === state.video), next = index + (action === 'next' ? 1 : -1);
      if (index < 0 || next < 0 || next >= queue.length) throw new Error('You reached the start or end of the queue.');
      await load(queue[next].id, state.list);
    } else if (action === 'select') {
      if (!Number.isInteger(command.index) || !queue[command.index]) throw new Error('This queue item does not exist.');
      await load(queue[command.index].id, state.list);
    } else throw new Error('Unknown player command.');
    await updateState(); return { state };
  }
  let serial = Promise.resolve();
  const server = net.createServer(socket => {
    let input = '';
    socket.setTimeout(45000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 32768) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end < 0) return;
      const line = input.slice(0, end); input = '';
      const reply = async () => {
        try { const result = await handle(JSON.parse(line)); socket.end(JSON.stringify({ ok: true, ...result }) + '\n'); }
        catch (error) { state.error = error.message; socket.end(JSON.stringify({ ok: false, error: error.message, state }) + '\n'); }
      };
      // status only reads the cached state, so it never waits behind a slow command.
      let status = false;
      try { status = JSON.parse(line).action === 'status'; } catch {}
      if (status) reply(); else serial = serial.then(reply);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  await writeFile(`${runtime}/terminal`, state.terminal || '');
  let ending = false;
  const cleanup = async () => { ending = true; await stopBrowser(); server.close(); await unlink(socketPath).catch(() => {}); process.stdout.write('\x1b[?25h'); process.exit(0); };
  process.once('SIGTERM', cleanup); process.once('SIGINT', cleanup); process.once('SIGHUP', cleanup);
  while (!ending) {
    const started = Date.now();
    if (player && !loading) {
      try { await updateState(); } catch (error) { if (!loading && player) state.error = error.message; }
    }
    const show = player && !loading && visible && state.video;
    try {
      if (!player) casting = false;
      else if (show && !state.paused && !casting) {
        const { cols, rows } = placement();
        await player.call('Page.startScreencast', { format: 'png', maxWidth: Math.round(cols * cell.width), maxHeight: Math.round(rows * cell.height), everyNthFrame: 1 });
        casting = true;
      } else if (casting && (!show || state.paused)) {
        casting = false; latestFrame = null;
        await player.call('Page.stopScreencast');
      }
      // Paused: no new frames come, so keep a still picture (and show seeks).
      still = show && state.paused ? stillPlan(still, JSON.stringify([state.video, state.time, placement(), cell])) : null;
      if (still?.send) {
        const { data } = await player.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await drawFrame(data);
      }
    } catch (error) { if (!loading && player) state.error = error.message; }
    await delay(Math.max(10, (state.paused ? 500 : 100) - (Date.now() - started)));
  }
}
