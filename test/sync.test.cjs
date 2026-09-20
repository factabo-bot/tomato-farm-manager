// node --test test/sync.test.cjs — no network or production spreadsheet access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('frontend/common.js', 'utf8');
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function client(storage = new Map()) {
  const listeners = {};
  const c = vm.createContext({
    CONFIG: { GAS_URL: 'https://test.invalid', APP_TOKEN: '' }, MASTERS_DEFAULT: { bases: [] },
    console: { ...console, warn: () => {} }, Date, Map, Set, URLSearchParams, AbortController, Event,
    setTimeout, clearTimeout, setInterval: () => 0,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    navigator: { onLine: true },
    document: { getElementById: () => null, visibilityState: 'visible' },
    window: { crypto, addEventListener: (name, fn) => { listeners[name] = fn; }, dispatchEvent: () => {} },
    crypto,
    fetch: () => { throw new Error('Unexpected network'); }
  });
  vm.runInContext(source, c);
  c.run = text => vm.runInContext(text, c);
  c.storage = storage;
  return c;
}
const plain = v => JSON.parse(JSON.stringify(v));

test('initial masters resolve before a slow network response; fresh callback updates later', async () => {
  const c = client(); const wait = deferred();
  c.apiGet = () => wait.promise;
  let fresh;
  const masters = await c.loadMasters(v => { fresh = v; });
  assert.deepEqual(plain(masters.bases), []);
  assert.equal(fresh, undefined);
  wait.resolve({ ok: true, bases: [{ name: 'remote' }] });
  await Promise.resolve();
  assert.equal(fresh.bases[0].name, 'remote');
});

test('queue is durable BEFORE response and survives closing/reopening a page', async () => {
  const storage = new Map(); const c = client(storage); const wait = deferred();
  c.postWithRetry = () => wait.promise;
  const sending = c.apiPostWithQueue({ clientId: 'one', base: 'A' });
  assert.equal(c.readQueue().length, 1);
  assert.equal(c.readQueue()[0].attempted, true);
  const reopened = client(storage);
  assert.equal(reopened.readQueue()[0].payload.clientId, 'one');
  wait.resolve({ ok: true, id: 'server-one' });
  await sending;
  assert.equal(c.readQueue().length, 0);
});

test('one sender, including records enqueued while sending; nothing is lost', async () => {
  const c = client(); const wait = deferred(); const sent = [];
  c.postWithRetry = async p => { sent.push(p.clientId); return p.clientId === 'one' ? wait.promise : { ok: true, id: 'two' }; };
  const first = c.apiPostWithQueue({ clientId: 'one' });
  const second = c.apiPostWithQueue({ clientId: 'two' });
  assert.deepEqual(sent, ['one']);
  wait.resolve({ ok: true, id: 'one' });
  await Promise.all([first, second]);
  assert.deepEqual(sent, ['one', 'two']);
  assert.equal(c.queueLength(), 0);
});

test('offline save is local immediately and sends on recovery with same client ID', async () => {
  const c = client(); c.navigator.onLine = false;
  c.storeAdd('work', { clientId: 'off', 作業日: c.formatToday(), 状態: '未同期' }, { clientId: 'off' });
  const result = await c.apiPostWithQueue({ clientId: 'off' });
  assert.equal(result.queued, true);
  assert.equal(c.queueLength(), 1);
  c.navigator.onLine = true;
  c.postWithRetry = async () => ({ ok: true, id: 'server' });
  await c.flushQueue();
  assert.equal(c.storeRead('work')[0].記録ID, 'server');
});

test('cancelling during an in-flight creation persists and sends a cancellation after acknowledgement', async () => {
  const c = client(); const wait = deferred(); const sent = [];
  c.storeAdd('work', { clientId: 'cancel', 作業日: c.formatToday(), 状態: '未同期' });
  c.postWithRetry = async p => { sent.push(p); return p.id ? { ok: true } : wait.promise; };
  const sending = c.apiPostWithQueue({ clientId: 'cancel', userId: 'u' });
  c.storePatch('work', 'c:cancel', { 状態: '取消' });
  c.dropQueuedRecord('cancel');
  assert.equal(c.readQueue()[0].cancelRequested, true);
  wait.resolve({ ok: true, id: 'new-id' });
  await sending;
  assert.equal(sent[1].type, 'cancelRecord');
  assert.equal(sent[1].id, 'new-id');
  assert.equal(c.storeRead('work')[0].状態, '取消');
});

test('stale pull cannot erase a new acknowledged record or undo a queued cancellation', () => {
  const c = client();
  c.enqueue({ type: 'cancelRecord', id: 'old' });
  const local = [ { 記録ID: 'old', 状態: '取消' }, { 記録ID: 'new', _localChangedAt: 200 } ];
  const merged = c.mergeRemoteRecords(local, [{ 記録ID: 'old', 状態: '完了' }], 100);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(x => x.記録ID === 'old').状態, '取消');
});

test('response lost after saving: incoming server row deduplicates by clientId', () => {
  const c = client();
  const rows = c.mergeRemoteRecords([{ clientId: 'same', 状態: '未同期' }], [{ clientId: 'same', 記録ID: 'server' }], Date.now());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].記録ID, 'server');
});

test('full and differential sync apply edits and deletion; stale other-tab result ignored', () => {
  const c = client(); const date = c.formatToday();
  let before = c.readStore();
  c.applySyncResponse({ full: true, cursor: 'a', deleted: [], items: [
    { _type: 'work', 記録ID: '1', 作業日: date, 備考: 'old' },
    { _type: 'work', 記録ID: '2', 作業日: date }
  ] }, before, 1);
  before = c.readStore();
  const response = { full: false, cursor: 'b', deleted: ['work:2'], items: [
    { _type: 'work', 記録ID: '1', 作業日: date, 備考: 'edited' }
  ] };
  c.applySyncResponse(response, before, Date.now());
  assert.equal(c.storeRead('work').length, 1);
  assert.equal(c.storeRead('work')[0].備考, 'edited');
  assert.equal(c.applySyncResponse({ ...response, cursor: 'stale' }, before, 1), false);
  assert.equal(c.readStore().cursor, 'b');
});

test('failed sync never advances last-success timestamp', async () => {
  const c = client(); c.apiGet = async () => ({ ok: false });
  await c.sync(null, true);
  assert.equal(c.readStore().syncedAt, 0);
  assert.match(c.run('syncError'), /同期できません/);
});

test('recent sync prevents redundant network calls on navigation', async () => {
  const c = client(); const store = c.readStore(); store.syncedAt = Date.now(); c.writeStore(store);
  let calls = 0; c.apiGet = async () => { calls++; return { ok: false }; };
  await c.sync(); assert.equal(calls, 0);
  await c.sync(null, true); assert.equal(calls, 1);
});

test('conflicting operations stop retrying and keep a visible explanation', async () => {
  const c = client(); let calls = 0;
  c.postWithRetry = async () => { calls++; return { ok: false, conflict: true, error: 'changed elsewhere' }; };
  await c.apiPostWithQueue({ type: 'cancelRecord', id: 'one' });
  await c.flushQueue();
  assert.equal(calls, 1);
  assert.equal(c.readQueue()[0].blocked, true);
  assert.match(c.readQueue()[0].lastError, /elsewhere/);
});

test('failed older feed log blocks newer log for same day from overtaking it', async () => {
  const c = client(); const calls = [];
  c.enqueue({ type: 'feedLog', clientId: 'old', feedDate: '2026-09-21' });
  c.enqueue({ type: 'feedLog', clientId: 'new', feedDate: '2026-09-21' });
  c.postWithRetry = async p => { calls.push(p.clientId); return { ok: false }; };
  await c.flushQueue();
  assert.deepEqual(calls, ['old']);
  assert.equal(c.queueLength(), 2);
});

test('storage failure throws before a saved state can be claimed', () => {
  const c = client(); c.getProfile();
  c.localStorage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => c.storeAdd('work', { clientId: 'one' }, { clientId: 'one' }), /quota/);
});

test('queue storage failure rolls back the local row so the input can be retried', () => {
  const c = client(); const put = c.localStorage.setItem;
  c.localStorage.setItem = (key, value) => { if (key === 'tfm_pending_queue') throw new Error('quota'); put(key, value); };
  assert.throws(() => c.storeAdd('work', { clientId: 'one' }, { clientId: 'one' }), /quota/);
  assert.equal(c.storeRead('work').length, 0);
});

test('an acknowledgement arriving during pull preserves the row and requests a fresh base next time', () => {
  const c = client(); const before = c.readStore();
  c.storeAdd('work', { 記録ID: 'new', 作業日: c.formatToday(), 状態: '完了' });
  c.applySyncResponse({ full: true, cursor: 'a', items: [], deleted: [] }, before, Date.now() - 100);
  assert.equal(c.storeRead('work').length, 1);
  assert.equal(c.readStore().cursor, '');
});

test('identical reads share a single request', async () => {
  const c = client(); const wait = deferred(); let calls = 0;
  c.fetch = async () => { calls++; await wait.promise; return { ok: true, text: async () => '{"ok":true}' }; };
  const first = c.apiGet('masters'); const second = c.apiGet('masters');
  assert.equal(calls, 1); wait.resolve();
  await Promise.all([first, second]);
});

test('installed app shell is returned from cache without waiting for network', async () => {
  const listeners = {}; const cached = { body: 'ready' }; let calls = 0;
  const c = vm.createContext({
    self: { location: { origin: 'https://app.invalid' }, addEventListener: (name, fn) => { listeners[name] = fn; } },
    caches: { match: async () => cached },
    fetch: async () => { calls++; return new Promise(() => {}); }
  });
  vm.runInContext(fs.readFileSync('frontend/sw.js', 'utf8'), c);
  let response;
  listeners.fetch({ request: { method: 'GET', url: 'https://app.invalid/work.html' }, respondWith: value => { response = value; } });
  assert.equal(await response, cached); assert.equal(calls, 0);
});

function server() {
  const sheets = new Map(); const cache = new Map();
  const c = vm.createContext({ console, Date,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => sheets.has(name) ? { getDataRange: () => ({ getValues: () => sheets.get(name) }) } : null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k), put: (k,v) => cache.set(k,v) }) },
    Utilities: { getUuid: () => crypto.randomUUID(), formatDate: d => d.toISOString().slice(0,10),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => crypto.createHash(alg).update(text).digest(),
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url') },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) }
  });
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), c);
  c.run = text => vm.runInContext(text, c);
  c.sheets = sheets; c.cache = cache;
  return c;
}

test('GAS delta detects direct sheet edits, detail edits and physical deletion; expired cursor gives full snapshot', () => {
  const c = server(); const date = new Date().toISOString().slice(0,10);
  const work = c.run('SHEET_WORK'); const spray = c.run('SHEET_SPRAY'); const items = c.run('SHEET_SPRAY_ITEMS');
  c.sheets.set(work, [['記録ID','作業日','状態','備考'], ['w', date, '完了','first']]);
  c.sheets.set(spray, [['記録ID','使用年月日','状態'], ['s',date,'完了']]);
  c.sheets.set(items, [['記録ID','資材名'], ['s','A']]);
  const first = c.getSync_({}); assert.equal(first.full, true); assert.equal(first.items.length, 2);
  const unchanged = c.getSync_({ cursor: first.cursor }); assert.equal(unchanged.items.length, 0);
  c.sheets.get(work)[1][3] = 'edited without timestamp';
  c.sheets.get(items)[1][1] = 'B';
  const edited = c.getSync_({ cursor: unchanged.cursor }); assert.equal(edited.items.length, 2);
  c.sheets.get(work).pop();
  const removed = c.getSync_({ cursor: edited.cursor }); assert.deepEqual(plain(removed.deleted), ['work:w']);
  c.cache.clear(); assert.equal(c.getSync_({ cursor: removed.cursor }).full, true);
});

test('GAS rejects a stale version, including manual sheet edits', () => {
  const c = server(); const work = c.run('SHEET_WORK'); const date = new Date().toISOString().slice(0,10);
  c.sheets.set(work, [['記録ID','作業日','状態','備考'], ['w',date,'完了','first']]);
  const initial = c.getSync_({}).items[0];
  const payload = { type: 'cancelRecord', id: 'w', expectedVersion: initial._version };
  assert.equal(c.checkRecordVersion_(payload), null);
  c.sheets.get(work)[1][3] = 'changed';
  assert.equal(c.checkRecordVersion_(payload).conflict, true);
});

test('GAS also detects conflicting edits to spray details', () => {
  const c = server(); const date = new Date().toISOString().slice(0,10);
  const spray = c.run('SHEET_SPRAY'); const items = c.run('SHEET_SPRAY_ITEMS');
  c.sheets.set(spray, [['記録ID','使用年月日','状態'], ['s',date,'予定']]);
  c.sheets.set(items, [['記録ID','資材名'], ['s','A']]);
  const payload = { type: 'completeSpray', id: 's', expectedVersion: c.getSync_({}).items[0]._version };
  assert.equal(c.checkRecordVersion_(payload), null);
  c.sheets.get(items)[1][1] = 'B';
  assert.equal(c.checkRecordVersion_(payload).conflict, true);
});
