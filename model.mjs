export function parseInput(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 500) throw new Error('Enter a search term or YouTube URL.');
  if (!/^(https?:\/\/|www\.|youtu\.be\/|(?:[\w-]+\.)?youtube\.com\/)/i.test(text)) {
    if (/^[\w-]{11}$/.test(text)) return { video: text };
    if (text.includes('://')) throw new Error('Only YouTube URLs are supported.');
    return { query: text };
  }
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Only YouTube URLs are supported.');
  const video = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || (/^\/(shorts|live|embed)\/([^/]+)/.exec(url.pathname)?.[2]);
  const list = url.searchParams.get('list');
  if (video && !/^[\w-]{11}$/.test(video)) throw new Error('Invalid video URL.');
  if (list && !/^[\w-]{2,150}$/.test(list)) throw new Error('Invalid playlist URL.');
  if (!video && !list) throw new Error('Paste a video or playlist URL.');
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
  const thumbnail = (type, id, sources = []) => {
    if (type === 'video') return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    const url = Array.isArray(sources) ? sources.at(-1)?.url : '';
    return typeof url === 'string' && /^https:\/\/i\.ytimg\.com\//.test(url) ? url : '';
  };
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'lockupViewModel') {
        const type = value.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' ? 'playlist' : value.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? 'video' : null;
        const id = value.contentId, metadata = value.metadata?.lockupMetadataViewModel;
        const title = metadata?.title?.content;
        if (type && title && !seen.has(`${type}:${id}`) && (type === 'video' ? /^[\w-]{11}$/.test(id) : /^[\w-]{2,150}$/.test(id))) {
          seen.add(`${type}:${id}`);
          items.push({ type, id, title, by: metadata.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '', duration: '', thumbnail: thumbnail(type, id, value.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources) });
        }
      } else if (['videoRenderer', 'playlistVideoRenderer', 'playlistPanelVideoRenderer', 'playlistRenderer'].includes(key)) {
        const type = key === 'playlistRenderer' ? 'playlist' : 'video';
        const id = type === 'playlist' ? value.playlistId : value.videoId;
        const title = text(value.title);
        if (id && title && !seen.has(`${type}:${id}`) && (type === 'video' ? /^[\w-]{11}$/.test(id) : /^[\w-]{2,150}$/.test(id))) {
          seen.add(`${type}:${id}`);
          items.push({ type, id, title, by: text(value.ownerText || value.shortBylineText || value.longBylineText), duration: text(value.lengthText), thumbnail: thumbnail(type, id, value.thumbnails?.[0]?.thumbnails || value.thumbnail?.thumbnails) });
        }
      } else walk(value);
    }
  }
  walk(data);
  return items;
}

// A Mix has no /playlist page; its videos are only in the watch page's
// playlist panel. The rest of that page is recommendations, not the Mix.
export function extractPanel(html) {
  const data = JSON.parse(/var ytInitialData = (\{.*?\});<\/script>/s.exec(html)?.[1] ?? 'null');
  return extractItems(data?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.contents ?? []).filter(x => x.type === 'video');
}

export function extractSearchPage(data) {
  const commands = data?.onResponseReceivedCommands ?? data?.onResponseReceivedActions;
  const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents
    ?? commands?.find(command => command.appendContinuationItemsAction)?.appendContinuationItemsAction?.continuationItems;
  if (!Array.isArray(contents)) throw new Error('YouTube returned invalid search results. Try again.');
  const continuation = contents.findLast(item => item.continuationItemRenderer)?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ?? null;
  if (continuation !== null && (typeof continuation !== 'string' || !continuation.length || continuation.length > 20000)) throw new Error('YouTube returned an invalid search cursor. Search again.');
  return { items: extractItems(contents), continuation };
}

// Herdr draws nothing while it decodes a new PNG, so each frame is sent
// without showing it and placed one frame later; three image ids rotate:
// the one being sent, the one being shown, and the old one being deleted.
export function framePacket(data, frame, cols, top = 1, left = 1) {
  const id = 42 + frame % 3, shown = 42 + (frame + 2) % 3, old = 42 + (frame + 1) % 3;
  let output = '';
  for (let offset = 0; offset < data.length; offset += 4096) {
    const more = offset + 4096 < data.length ? 1 : 0;
    const header = offset ? `m=${more}` : `a=t,f=100,t=d,i=${id},q=2,m=${more}`;
    output += `\x1b_G${header};${data.slice(offset, offset + 4096)}\x1b\\`;
  }
  // Let the terminal derive height from the source pixels. Sending both
  // dimensions stretches frames in Herdr's current Kitty implementation.
  if (frame > 0) output += `\x1b[${top};${left}H\x1b_Ga=p,i=${shown},p=1,q=2,C=1,c=${cols}\x1b\\`;
  if (frame > 1) output += `\x1b_Ga=d,d=i,i=${old},q=2\x1b\\`;
  return output;
}
