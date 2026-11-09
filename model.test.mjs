import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, samePage, extractItems, extractSearchPage, framePacket } from './model.mjs';

test('matches YouTube canonical query encoding without accepting stale searches', () => {
  assert.ok(samePage('https://www.youtube.com/results?search_query=Big+Buck', 'https://www.youtube.com/results?search_query=Big%20Buck'));
  assert.ok(!samePage('https://www.youtube.com/results?search_query=old', 'https://www.youtube.com/results?search_query=new'));
});

test('accepts search, video, short link and public playlist input', () => {
  assert.deepEqual(parseInput('爵士音樂'), { query: '爵士音樂' });
  assert.deepEqual(parseInput('https://youtu.be/aqz-KE-bpKQ?si=hello'), { video: 'aqz-KE-bpKQ' });
  assert.deepEqual(parseInput('https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PLabc'), { video: 'aqz-KE-bpKQ', list: 'PLabc' });
  assert.deepEqual(parseInput('https://www.youtube.com/playlist?list=PLabc'), { list: 'PLabc' });
  for (const input of ['', 'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ', 'https://youtube.com@evil.test/', 'https://youtube.com:123/watch?v=aqz-KE-bpKQ', 'file:///tmp/video', 'https://youtube.com/watch?v=bad']) assert.throws(() => parseInput(input));
});

test('extracts and deduplicates nested search and playlist entries', () => {
  const videoRenderer = { videoId: 'aqz-KE-bpKQ', title: { runs: [{ text: 'Big ' }, { text: 'Buck Bunny' }] } };
  const data = { contents: [{ videoRenderer }, { playlistVideoRenderer: videoRenderer }, { playlistRenderer: { playlistId: 'PLabc', title: { simpleText: '清單' } } }] };
  assert.deepEqual(extractItems(data).map(x => [x.type, x.title]), [['video', 'Big Buck Bunny'], ['playlist', '清單']]);
  assert.deepEqual(extractItems({ lockupViewModel: { contentId: 'PLnew', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: '新版清單' } } } } }).map(x => [x.type, x.id, x.title]), [['playlist', 'PLnew', '新版清單']]);
});

test('graphics chunks preserve complete frame bytes and terminate correctly', () => {
  const data = Buffer.alloc(9000, 7).toString('base64');
  const chunks = [...framePacket(data, 0, 70).matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/g)];
  assert.equal(chunks.map(x => x[2]).join(''), data);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0][1].startsWith('a=t,') && chunks[0][1].includes('m=1'));
  assert.equal(chunks.at(-1)[1], 'm=0');
});

test('each frame is shown one frame after it is sent, then deleted', () => {
  const commands = frame => [...framePacket('AAAA', frame, 52, 1, 5).matchAll(/\x1b_G([^;\x1b]+)/g)].map(x => x[1]);
  assert.deepEqual(commands(0), ['a=t,f=100,t=d,i=42,q=2,m=0']);
  const third = commands(2);
  assert.ok(third[0].includes('i=44'), 'sends the new frame');
  assert.ok(third[1].startsWith('a=p,i=43,p=1') && !third[1].includes(',r='), 'shows the previous frame, height from source');
  assert.equal(third[2], 'a=d,d=i,i=42,q=2', 'deletes the frame before that');
});

test('extracts video and playlist thumbnails, rejecting external image hosts', () => {
  const playlist = (id, url) => ({ playlistRenderer: { playlistId: id, title: { simpleText: id }, thumbnails: [{ thumbnails: [{ url }] }] } });
  const items = extractItems([
    { videoRenderer: { videoId: 'aqz-KE-bpKQ', title: { simpleText: 'Video' } } },
    playlist('PLgood', 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg'),
    playlist('PLbad', 'https://i.ytimg.com.evil.test/picture.jpg'),
    { lockupViewModel: { contentId: 'PLnew', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: 'Playlist' } } }, contentImage: { collectionThumbnailViewModel: { primaryThumbnail: { thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg' }] } } } } } } },
  ]);
  assert.equal(items[0].thumbnail, 'https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg');
  assert.equal(items[1].thumbnail, 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg');
  assert.equal(items[2].thumbnail, '');
  assert.equal(items[3].thumbnail, items[0].thumbnail);
});

test('search cursors come from the main results, not nested recommendation shelves', () => {
  const cursor = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  const contents = [{ itemSectionRenderer: { contents: [
    { videoRenderer: { videoId: 'aqz-KE-bpKQ', title: { simpleText: 'Video' } } },
    { shelfRenderer: { contents: [cursor('shelf-cursor')] } },
  ] } }, cursor('search-cursor')];
  const initial = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents } } } } };
  const page = extractSearchPage(initial);
  assert.equal(page.items.length, 1);
  assert.equal(page.continuation, 'search-cursor');
  for (const key of ['onResponseReceivedCommands', 'onResponseReceivedActions']) {
    assert.deepEqual(extractSearchPage({ [key]: [{ appendContinuationItemsAction: { continuationItems: contents } }] }), page);
    assert.equal(extractSearchPage({ [key]: [{ appendContinuationItemsAction: { continuationItems: contents.slice(0, 1) } }] }).continuation, null);
  }
  assert.throws(() => extractSearchPage({ error: { message: 'Search unavailable' } }), /invalid search results/);
  assert.throws(() => extractSearchPage({ onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [cursor(123)] } }] }), /invalid search cursor/);
});
