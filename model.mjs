export function parseInput(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 500) throw new Error('請輸入搜尋文字或 YouTube 網址。');
  if (!/^(https?:\/\/|www\.|youtu\.be\/|(?:[\w-]+\.)?youtube\.com\/)/i.test(text)) {
    if (/^[\w-]{11}$/.test(text)) return { video: text };
    if (text.includes('://')) throw new Error('只接受 YouTube 網址。');
    return { query: text };
  }
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('只接受 YouTube 網址。');
  const video = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || (/^\/(shorts|live|embed)\/([^/]+)/.exec(url.pathname)?.[2]);
  const list = url.searchParams.get('list');
  if (video && !/^[\w-]{11}$/.test(video)) throw new Error('影片網址格式不正確。');
  if (list && !/^[\w-]{2,150}$/.test(list)) throw new Error('播放清單網址格式不正確。');
  if (!video && !list) throw new Error('請貼影片或播放清單網址。');
  return { ...(video ? { video } : {}), ...(list ? { list } : {}) };
}

// ytInitialData contains the public page's results, without a Data API key.
export function samePage(current, target) {
  const a = new URL(current), b = new URL(target);
  return a.origin === b.origin && a.pathname === b.pathname && [...b.searchParams].every(([key, value]) => a.searchParams.get(key) === value);
}

export function extractItems(data) {
  const items = [], seen = new Set();
  const text = value => value?.simpleText || value?.runs?.map(r => r.text).join('') || '';
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'lockupViewModel') {
        const type = value.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' ? 'playlist' : value.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? 'video' : null;
        const id = value.contentId, metadata = value.metadata?.lockupMetadataViewModel;
        const title = metadata?.title?.content;
        if (type && title && !seen.has(`${type}:${id}`) && (type === 'video' ? /^[\w-]{11}$/.test(id) : /^[\w-]{2,150}$/.test(id))) {
          seen.add(`${type}:${id}`);
          items.push({ type, id, title, by: metadata.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '', duration: '' });
        }
      } else if (['videoRenderer', 'playlistVideoRenderer', 'playlistPanelVideoRenderer', 'playlistRenderer'].includes(key)) {
        const type = key === 'playlistRenderer' ? 'playlist' : 'video';
        const id = type === 'playlist' ? value.playlistId : value.videoId;
        const title = text(value.title);
        if (id && title && !seen.has(`${type}:${id}`) && (type === 'video' ? /^[\w-]{11}$/.test(id) : /^[\w-]{2,150}$/.test(id))) {
          seen.add(`${type}:${id}`);
          items.push({ type, id, title, by: text(value.ownerText || value.shortBylineText || value.longBylineText), duration: text(value.lengthText) });
        }
      } else walk(value);
    }
  }
  walk(data);
  return items;
}

export function graphicsPacket(data, cols, rows, top = 1, left = 1) {
  let output = `\x1b[${top};${left}H`;
  for (let offset = 0; offset < data.length; offset += 4096) {
    const more = offset + 4096 < data.length ? 1 : 0;
    // Let the terminal derive height from the source pixels. Sending both
    // dimensions stretches frames in Herdr's current Kitty implementation.
    const header = offset ? `m=${more}` : `a=T,f=100,t=d,i=42,p=1,q=2,C=1,c=${cols},m=${more}`;
    output += `\x1b_G${header};${data.slice(offset, offset + 4096)}\x1b\\`;
  }
  return output;
}
