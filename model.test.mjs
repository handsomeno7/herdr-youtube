import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, samePage, extractItems, graphicsPacket } from './model.mjs';

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
  const chunks = [...graphicsPacket(data, 70, 20).matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/g)];
  assert.equal(chunks.map(x => x[2]).join(''), data);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0][1].includes('m=1'));
  assert.ok(chunks[0][1].includes('p=1'));
  assert.ok(!chunks[0][1].includes(',r='), 'height must follow the source aspect ratio');
  assert.equal(chunks.at(-1)[1], 'm=0');
});
