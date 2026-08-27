"use strict";

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function formatDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatToday() {
  return formatDate(new Date());
}

function nowTimestamp() {
  const d = new Date();
  return formatDate(d) + " " + d.toTimeString().slice(0, 8);
}

// 記録の時刻をHH:mmで取り出す。
// シートの時刻セルはDate型になることがあり、GASを通ると "1899-12-30 09:20:00" や
// "2026-08-25 08:10:00" のような文字列で返ってくるため、時刻の部分だけを拾う
function timeLabel(v) {
  const m = String(v || "").match(/(\d{1,2}):(\d{2})/);
  return m ? m[1].padStart(2, "0") + ":" + m[2] : "";
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

// ---------- 散布の調製計算 ----------
// 防除は散布前に調製の計算をしてから行う。その計算がそのまま記録になる。
// 式は 総調製量(L) × 1000 ÷ 倍率 = 投入量（mL または g）。
// 2026-08-01の達子さんの指示書と同じ出し方（200L・2000倍 → 100cc）

// 「1000倍」「2,000」のような書き方から倍率の数値を取り出す
function parseDilution(v) {
  const n = Number(String(v == null ? "" : v).replace(/[,，倍\s]/g, ""));
  return n > 0 ? n : null;
}

function doseFor(volumeL, dilution) {
  const v = Number(volumeL);
  const n = parseDilution(dilution);
  if (!(v > 0) || !n) return null;
  return (v * 1000) / n;
}

// 少数第1位まで。100.0 は 100 と出す
function formatDose(v) {
  if (v === null || v === undefined) return "";
  const r = Math.round(v * 10) / 10;
  return String(r);
}

// 何回に分けて調製するか。割り切れないときは最後の1回だけ容量が減る
function batchPlan(totalL, batchL) {
  const t = Number(totalL);
  const b = Number(batchL);
  if (!(t > 0) || !(b > 0)) return null;
  const count = Math.ceil(t / b);
  const lastL = Math.round((t - b * (count - 1)) * 10) / 10;
  return { count: count, batchL: b, lastL: lastL };
}

// 調製表の1行分。合計と1回あたりを出す
function mixRow(item, totalL, batchL) {
  const unit = item.unit || "";
  return {
    materialName: item.materialName,
    dilution: parseDilution(item.dilution),
    unit: unit,
    total: doseFor(totalL, item.dilution),
    perBatch: doseFor(batchL, item.dilution),
  };
}

// ---------- 利用者プロフィール（この端末での記録者名。共有端末なら都度変更可） ----------

function getProfile() {
  let userId = localStorage.getItem("tfm_userId");
  if (!userId) {
    userId = "local-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("tfm_userId", userId);
  }
  const displayName = localStorage.getItem("tfm_displayName") || "自分";
  return { userId, displayName };
}

function setDisplayName(name) {
  localStorage.setItem("tfm_displayName", name);
}

const isMock = !CONFIG.GAS_URL;

// ---------- API通信 ----------

// 読み取りもPOSTと同じくときどき404のHTMLが返る（実測で6回中2回）。
// 以前はここで例外になり、呼び出し側の描画が途中で止まって画面が空のままになっていた
// ＝「記録が無い」のか「読めなかった」のか区別が付かなかった。
// 読み取りは何度実行しても副作用がないので、無条件に数回試す。
// それでも駄目なら {ok:false} を返したうえでその場に知らせる（黙って空にしない）
const GET_TRIES = 3;

async function apiGet(action, params) {
  if (isMock) return mockGet(action, params || {});
  let lastErr = null;
  for (let i = 0; i < GET_TRIES; i++) {
    if (i > 0) await sleep(400 * i);
    try {
      const qs = new URLSearchParams(Object.assign({ action }, params || {}, { _: Date.now() }));
      const res = await fetch(CONFIG.GAS_URL + "?" + qs.toString());
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn("読み込みに失敗", action, lastErr);
  toast("⚠ 読み込めませんでした（" + action + "）。通信を確かめて開き直してください");
  return { ok: false, error: "読み込めませんでした" };
}

// GASのウェブアプリはPOSTを受けると script.googleusercontent.com へリダイレクトする。
// この往復はときどき失敗する（Google側の一時的な不調で、実測でも数分だけ集中して起きた）。
// 壊れ方は2つあり、扱いを変える必要がある。
//   1. doGet の返事が返ってくる → POSTの本文がGASまで届かず、GETとして処理された。
//      何も書き込まれていないのに {ok:true} なので、放っておくと黙って成功扱いになり
//      記録が消える。書き込みは起きていないので、そのまま送り直してよい。
//   2. JSONでない応答（404のHTML等）→ 結果を読めなかっただけで、リダイレクト後なら
//      GAS側では処理済みかもしれない。送り直すと同じ記録が2件できるので繰り返さない。
const GET_GREETING = "tomato-farm-manager API"; // Code.gs の doGet が返す既定メッセージ
const POST_TRIES = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function postError(message, safeToRetry) {
  const err = new Error(message);
  err.safeToRetry = safeToRetry;
  return err;
}

// Content-Type: text/plain にするとCORSのプリフライトが発生しない（GASの定石）
async function postOnce(payload) {
  const res = await fetch(CONFIG.GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = null;
  }

  if (data && data.message === GET_GREETING) {
    throw postError("送信内容がサーバーまで届きませんでした", true);
  }
  if (data) return data;

  throw res.redirected
    ? postError("送信できたか確認できませんでした（HTTP " + res.status + "）。履歴を確認してください", false)
    : postError("サーバーに届きませんでした（HTTP " + res.status + "）", true);
}

async function postWithRetry(payload) {
  let lastErr = null;
  for (let i = 0; i < POST_TRIES; i++) {
    if (i > 0) await sleep(500 * i);
    try {
      return await postOnce(payload);
    } catch (err) {
      lastErr = err;
      if (err.safeToRetry === false) break; // 処理済みかもしれないので送り直さない
    }
  }
  throw lastErr || new Error("送信できませんでした");
}

// 失敗しても投げずに {ok:false} で返す（呼び出し側はこの形を前提にしている）
async function apiPost(payload) {
  if (CONFIG.APP_TOKEN) payload.token = CONFIG.APP_TOKEN;
  if (isMock) return mockPost(payload);
  try {
    return await postWithRetry(payload);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- マスタのキャッシュ ----------
// GASのAPIは応答に5秒前後かかる（Apps Script側の構造的な遅さ）。
// マスタは滅多に変わらないので、前回取得した内容をlocalStorageに残しておき、
// 画面は即座にそれで描画してから、裏で最新版を取りに行く。

const MASTERS_CACHE_KEY = "tfm_masters_cache";
// マスタの取得は実測で8〜11秒かかる。GASは同じ利用者の処理を順番にしか実行しないので、
// 画面を開くたびに走らせると他の読み込みまで待たされる。しばらくは取りに行かない
const MASTERS_TTL_MS = 60 * 60 * 1000;

// 保存形式は { savedAt, data }。以前のキャッシュは中身が直に入っているので両方読めるようにする
function readMastersCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(MASTERS_CACHE_KEY) || "null");
    if (!raw) return { data: null, savedAt: 0 };
    if (raw.data) return { data: raw.data, savedAt: raw.savedAt || 0 };
    return { data: raw, savedAt: 0 }; // 旧形式。取得時刻が分からないので古い扱い
  } catch (err) {
    console.warn("マスタキャッシュの読み込みに失敗", err);
    return { data: null, savedAt: 0 };
  }
}

function getCachedMasters() {
  return readMastersCache().data;
}

function saveMastersCache(masters) {
  try {
    localStorage.setItem(MASTERS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data: masters }));
  } catch (err) {
    console.warn("マスタキャッシュの保存に失敗", err);
  }
}

// キャッシュがあれば待たずにそれを返し、裏で最新版を取得する。
// 取得結果がキャッシュと違っていたときだけ onFresh(最新マスタ) が呼ばれる
// （利用者が入力中に画面が作り替わるのを避けるため、変化がなければ何もしない）。
// キャッシュがない初回だけは取得を待つ。
async function loadMasters(onFresh) {
  const { data: cached, savedAt } = readMastersCache();

  // 取ったばかりのキャッシュがあるなら通信しない（マスタは滅多に変わらない）
  if (cached && Date.now() - savedAt < MASTERS_TTL_MS) return cached;

  const fetching = apiGet("masters")
    .then((fresh) => {
      if (!fresh || !fresh.ok) return null;
      const changed = JSON.stringify(fresh) !== JSON.stringify(cached);
      saveMastersCache(fresh);
      if (changed && cached && onFresh) onFresh(fresh);
      return fresh;
    })
    .catch((err) => {
      console.warn("マスタの取得に失敗（キャッシュで継続）", err);
      return null;
    });

  if (cached) return cached;
  const fresh = await fetching;
  return fresh || Object.assign({ ok: true }, MASTERS_DEFAULT);
}

// ---------- 手元の記録ストア ----------
// GASは何もしないAPIでも1.5秒かかる（実測）。毎回サーバーに聞いてから描いていたので、
// 開くたびに数秒なにも出なかった。記録はこの端末に持ち、画面は常にここだけを見て描く。
// サーバーとのやり取りは裏で行い、画面を待たせない。
//
// 保持は直近90日。実測で21日26件なので localStorage で足りる
// （足りなくなったら IndexedDB に移す。いまは不要）

const STORE_KEY = "tfm_store";
const STORE_DAYS = 90;
const KINDS = ["work", "spray", "growth"];

function emptyStore() {
  return { userId: "", work: [], spray: [], growth: [], weather: [], syncedAt: 0 };
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    // 利用者が変わったストアは使わない（別の人の記録を自分のものとして見せないため）
    if (raw && raw.userId === getProfile().userId) return Object.assign(emptyStore(), raw);
  } catch (err) {
    console.warn("記録ストアの読み込みに失敗", err);
  }
  return emptyStore();
}

function writeStore(store) {
  try {
    store.userId = getProfile().userId;
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn("記録ストアの保存に失敗", err);
  }
}

// 記録の日付の列名は種類ごとに違う
function recordDate(kind, r) {
  const v = kind === "work" ? r["作業日"] : kind === "growth" ? r["調査日"] : r["使用年月日"];
  return String(v || "").slice(0, 10);
}

// サーバーに載った記録は記録IDで、まだ送れていない記録はclientIdで見分ける
function recordKey(r) {
  return r["記録ID"] ? "s:" + r["記録ID"] : "c:" + (r.clientId || "");
}

function payloadKind(payload) {
  if (payload.type === "spray" || payload.type === "pesticide") return "spray";
  if (payload.type === "growth") return "growth";
  return "work";
}

function storeRead(kind) {
  return readStore()[kind] || [];
}

// 手元で作った記録を足す（送信を待たずに画面へ出すため）
function storeAdd(kind, record) {
  const store = readStore();
  store[kind] = (store[kind] || []).concat([record]);
  writeStore(store);
}

// 同じ記録を差し替える。無ければ何もしない
function storePatch(kind, key, patch) {
  const store = readStore();
  store[kind] = (store[kind] || []).map((r) => (recordKey(r) === key ? Object.assign({}, r, patch) : r));
  writeStore(store);
}

// 送信が通ったあと、その記録がサーバー側でどの状態になるか。
// 散布は散布前に作る調製シートなので「予定」で入る（GAS側 saveSpray_ と同じ）
function syncedStatus(payload) {
  if (payload.type === "spray" || payload.type === "pesticide") {
    return payload.status === "完了" ? "完了" : "予定";
  }
  return "完了";
}

// 送信が通ったら、サーバーが採番した記録IDを書き戻して「未同期」を外す
function storeMarkSynced(kind, clientId, serverId, status) {
  if (!clientId) return;
  storePatch(kind, "c:" + clientId, { 記録ID: serverId || "", 状態: status || "完了" });
}

function storePrune(store) {
  const limit = new Date();
  limit.setDate(limit.getDate() - STORE_DAYS);
  const limitKey = formatDate(limit);
  KINDS.forEach((kind) => {
    store[kind] = (store[kind] || []).filter((r) => recordDate(kind, r) >= limitKey);
  });
  store.weather = (store.weather || []).filter((w) => String(w.日付 || "").slice(0, 10) >= limitKey);
  return store;
}

// 履歴の日付見出しに出す天気。日付で引けるようにしておく
function weatherMap() {
  const map = {};
  (readStore().weather || []).forEach((w) => { map[String(w.日付 || "").slice(0, 10)] = w; });
  return map;
}

function newClientId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

// 記録は手元に書いたあと、この関数で裏から送る。
// 通れば記録IDを書き戻し、送れなければキューに残る（どちらでも手元の記録は消えない）
async function sendRecord(kind, payload, onDone) {
  try {
    const res = await apiPostWithQueue(payload);
    if (res.ok && !res.queued) {
      storeMarkSynced(kind, payload.clientId, res.id, syncedStatus(payload));
    } else if (!res.ok) {
      // サーバーに届いたが受け付けられなかった。理由を残して気づけるようにする
      storePatch(kind, "c:" + payload.clientId, { 状態: "送信エラー", 送信エラー: res.error || "" });
      toast("⚠ " + (res.error || "記録を保存できませんでした"));
    }
  } catch (err) {
    console.error(err);
    storePatch(kind, "c:" + payload.clientId, { 状態: "送信エラー", 送信エラー: String((err && err.message) || err) });
  }
  updateQueueBadge();
  if (onDone) onDone();
}

// 取消の連絡。届かなければキューに残り、あとで送られる
function cancelType(kind) {
  if (kind === "spray") return "cancelSpray";
  if (kind === "growth") return "cancelGrowth";
  return "cancelRecord";
}

async function sendCancel(kind, id, userId, onDone) {
  const payload = { type: cancelType(kind), id, userId };
  try {
    const res = await apiPostWithQueue(payload);
    if (!res.ok) toast("⚠ " + (res.error || "取消をサーバーに伝えられませんでした"));
  } catch (err) {
    console.error(err);
  }
  updateQueueBadge();
  if (onDone) onDone();
}

// 「予定」を「実施」に変える連絡。届かなければキューに残り、あとで送られる
async function sendComplete(kind, id, userId, times, onDone) {
  const payload = Object.assign({ type: "completeSpray", id: id, userId: userId }, times || {});
  try {
    const res = await apiPostWithQueue(payload);
    if (!res.ok) toast("⚠ " + (res.error || "実施をサーバーに伝えられませんでした"));
  } catch (err) {
    console.error(err);
  }
  updateQueueBadge();
  if (onDone) onDone();
}

// まだ送っていない記録を取り消したときは、キューに積まれた送信も取り下げる
function dropQueuedRecord(clientId) {
  if (!clientId) return;
  writeQueue(readQueue().filter((item) => (item.payload || {}).clientId !== clientId));
}

// ---------- 同期 ----------
// ① 溜まっている送信を出す ② サーバーの内容を取り込む、の順で回す。
// スプレッドシートは台帳として直接編集されるので、②は必須（送るだけでは足りない）

let syncing = false;
let syncLabel = "";

// お試しモードでも同じ道を通す（mockGet/mockPostがサーバーの代わりになる）
async function sync(onChange) {
  if (syncing) return;
  syncing = true;
  syncLabel = "同期中…";
  updateQueueBadge();
  try {
    await flushQueue();
    const changed = await pullRecords();
    if (changed && onChange) onChange();
  } catch (err) {
    console.warn("同期に失敗", err);
  } finally {
    syncing = false;
    syncLabel = "";
    updateQueueBadge();
  }
}

// 90日分をまるごと取り直して置き換える。
// 差分ではなく総取りにしているのは、シート側での手直しや行削除も拾う必要があるため。
// 裏で走るので遅くても画面は止まらない。
// 気象も一緒に持ってきて、履歴を開くたびに取りに行かなくて済むようにする
async function pullRecords() {
  const since = new Date();
  since.setDate(since.getDate() - STORE_DAYS);
  const [res, weatherRes] = await Promise.all([
    apiGet("history", { days: STORE_DAYS }),
    apiGet("weatherRange", { from: formatDate(since), to: formatToday() }),
  ]);
  if (!res || !res.ok) return false;

  const fetched = { work: [], spray: [], growth: [] };
  (res.items || []).forEach((it) => {
    const kind = it._type === "spray" ? "spray" : it._type === "growth" ? "growth" : "work";
    fetched[kind].push(it);
  });

  const store = readStore();
  const before = JSON.stringify([KINDS.map((k) => store[k] || []), store.weather || []]);
  if (weatherRes && weatherRes.ok) store.weather = weatherRes.items || [];

  KINDS.forEach((kind) => {
    // まだ送れていない記録はサーバーに無いので、取り込んだ内容に足し戻す。
    // 送る前に取り消したものは送られないので、ここで落とす
    const pending = (store[kind] || []).filter((r) => !r["記録ID"] && r.状態 !== "取消");
    store[kind] = fetched[kind].concat(pending);
  });
  storePrune(store);
  store.syncedAt = Date.now();
  writeStore(store);

  return JSON.stringify([KINDS.map((k) => store[k] || []), store.weather || []]) !== before;
}

// オフライン等でsubmitが失敗したときに使う。送信キューに積んで later flush する
async function apiPostWithQueue(payload) {
  if (CONFIG.APP_TOKEN) payload.token = CONFIG.APP_TOKEN;
  if (isMock) return mockPost(payload);
  try {
    return await postWithRetry(payload);
  } catch (err) {
    enqueue(payload);
    return { ok: true, queued: true };
  }
}

// ---------- 送信キュー（電波が弱いハウス内でも記録できるようにする） ----------

const QUEUE_KEY = "tfm_pending_queue";

function enqueue(payload) {
  const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  q.push({ payload, savedAt: Date.now() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  updateQueueBadge();
}

function queueLength() {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]").length;
}

async function flushQueue() {
  if (isMock) return;
  if (!navigator.onLine) return;
  const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  if (q.length === 0) return;
  const remain = [];
  let sentCount = 0;
  for (const item of q) {
    try {
      const data = await postWithRetry(item.payload);
      if (data.ok) {
        sentCount++;
        // 手元の記録にサーバーの記録IDを書き戻して「未同期」を外す
        storeMarkSynced(payloadKind(item.payload), item.payload.clientId, data.id, syncedStatus(item.payload));
      } else {
        // サーバーに届いたが受け付けられなかった。原因を残さないと
        // 「未送信◯件」が消えない理由が分からなくなる
        item.lastError = data.error || "サーバーが受け付けませんでした";
        remain.push(item);
      }
    } catch (err) {
      item.lastError = err.message || "通信できませんでした";
      remain.push(item); // まだオフライン、または送信が届かなかった。残す
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remain));
  updateQueueBadge();
  if (sentCount > 0) toast(`保留中だった記録 ${sentCount}件を送信しました`);
}

// 未送信があるときは目立たせ、無いときは最終同期を控えめに出す。
// 「送れているのか」が常に分かる状態にしておく
function updateQueueBadge() {
  const badge = $("queue-badge");
  if (!badge) return;
  const n = queueLength();
  const panel = document.getElementById("queue-panel");

  if (!badge.dataset.bound) {
    badge.dataset.bound = "1";
    badge.addEventListener("click", toggleQueuePanel);
  }

  badge.hidden = false;
  badge.classList.toggle("quiet", n === 0);
  if (n > 0) {
    badge.textContent = `📤 未送信 ${n}件（タップで中身を見る）`;
  } else if (syncLabel) {
    badge.textContent = "🔄 " + syncLabel;
  } else {
    const at = readStore().syncedAt;
    badge.textContent = at ? "✓ 最終同期 " + timeLabel(new Date(at).toTimeString()) : "✓ 手元に保存中";
  }

  if (n === 0) {
    if (panel) panel.hidden = true;
  } else if (panel && !panel.hidden) {
    renderQueuePanel();
  }
}

// ---------- 未送信の中身を見る・捨てる ----------
// サーバーに拒否され続ける記録が1件でも残ると「未送信◯件」が消えなくなるので、
// 中身を確かめて捨てられるようにしておく

function readQueue() {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
}

function writeQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  updateQueueBadge();
}

function queueKey(item) {
  return (item.savedAt || 0) + "|" + JSON.stringify(item.payload || {});
}

function queueItemLabel(payload) {
  if (payload.type === "spray" || payload.type === "pesticide") {
    const names = (payload.items || [])
      .map((it) => it.materialName || it.pesticideName)
      .filter(Boolean)
      .join("・");
    return `🧪 ${payload.useDate || ""} ${payload.base || ""} / ${names || "散布"}`;
  }
  if (payload.type === "growth") {
    return `📏 ${payload.surveyDate || ""} ${payload.base || ""} / 生育調査 ${(payload.items || []).length}株`;
  }
  return `📝 ${payload.workDate || ""} ${payload.base || ""} / ${payload.workType || "作業"}`;
}

function ensureQueuePanel() {
  let panel = document.getElementById("queue-panel");
  if (panel) return panel;
  const badge = $("queue-badge");
  if (!badge) return null;
  panel = el("div", "queue-panel");
  panel.id = "queue-panel";
  panel.hidden = true;
  badge.insertAdjacentElement("afterend", panel);
  return panel;
}

function toggleQueuePanel() {
  const panel = ensureQueuePanel();
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderQueuePanel();
}

function renderQueuePanel() {
  const panel = ensureQueuePanel();
  if (!panel) return;
  const q = readQueue();
  panel.innerHTML = "";
  if (q.length === 0) {
    panel.hidden = true;
    return;
  }

  q.forEach((item) => {
    const row = el("div", "item");
    const box = el("div", "grow");
    box.appendChild(el("div", "", queueItemLabel(item.payload || {})));
    const when = new Date(item.savedAt || Date.now());
    const stamp = formatDate(when) + " " + when.toTimeString().slice(0, 5);
    box.appendChild(el("div", "sub", item.lastError ? `${stamp} 保留・${item.lastError}` : `${stamp} 保留`));
    row.appendChild(box);

    const del = el("button", "del", "捨てる");
    del.type = "button";
    del.addEventListener("click", () => {
      if (del.dataset.arm !== "1") {
        del.dataset.arm = "1";
        del.textContent = "本当に捨てる？";
        setTimeout(() => {
          del.dataset.arm = "";
          del.textContent = "捨てる";
        }, 3000);
        return;
      }
      // 並び順ではなく中身で照合する（再描画との行ズレで別の記録を捨てないため）
      const key = queueKey(item);
      writeQueue(readQueue().filter((x) => queueKey(x) !== key));
      renderQueuePanel();
      toast("未送信の記録を捨てました");
    });
    row.appendChild(del);
    panel.appendChild(row);
  });

  const retry = el("button", "btn-secondary", "📤 いま送信を試す");
  retry.type = "button";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    await flushQueue();
    renderQueuePanel();
    retry.disabled = false;
  });
  panel.appendChild(retry);
}

// 同期のきっかけ。画面はストアを見て描いているので、いつ走っても待たせない。
// 各画面は onStoreChange に描き直す処理を入れて、取り込みが済んだら反映させる
let onStoreChange = null;

function syncNow() {
  sync(() => { if (onStoreChange) onStoreChange(); });
}

window.addEventListener("online", syncNow);
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncNow(); // アプリに戻ったとき
});
window.addEventListener("DOMContentLoaded", () => {
  updateQueueBadge();
  syncNow();
});

// ---------- お試しモード（GAS未接続。localStorageのみで動く） ----------

const MOCK_WORK_KEY = "tfm_mock_work";
const MOCK_SPRAY_KEY = "tfm_mock_spray";
const MOCK_GROWTH_KEY = "tfm_mock_growth";

// 目的タグを1列にまとめるときの区切り文字（GAS側 PURPOSE_SEPARATOR と合わせる）
const PURPOSE_SEPARATOR = "、";

// 散布区分の判定に使う区分の分類（GAS側 KUBUN_PEST_CONTROL / KUBUN_FOLIAR と合わせる）
const KUBUN_PEST_CONTROL = ["殺虫剤", "殺菌剤", "殺虫殺菌剤", "除草剤", "殺ダニ剤", "生物殺虫剤（微生物）", "殺虫剤（気門封鎖剤）"];
const KUBUN_FOLIAR = ["葉面散布肥料", "液体肥料", "葉面散布剤"];

function mockPost(payload) {
  if (payload.type === "spray" || payload.type === "pesticide") return mockSaveSpray(payload);
  if (payload.type === "cancelRecord") return mockCancelWork(payload);
  if (payload.type === "cancelSpray" || payload.type === "cancelPesticide") return mockCancelSpray(payload);
  if (payload.type === "completeSpray") return mockCompleteSpray(payload);
  if (payload.type === "growth") return mockSaveGrowth(payload);
  if (payload.type === "cancelGrowth") return mockCancelGrowth(payload);
  if (payload.type === "updateRecord") return mockUpdateWork(payload);
  return mockSaveWork(payload);
}

// 「0個だった」という記録にも意味があるので、0を空欄に潰さない
// （障害果が0だった週と、そもそも数えなかった週は区別したい。GAS側 keep_ と同じ）
function keepValue(v) {
  return (v === undefined || v === null || v === "") ? "" : v;
}

// 同じ clientId で送り直されたら既存の記録IDを返す（GAS側 findByClientId_ と同じ）
function mockFindByClientId(key, clientId) {
  if (!clientId) return "";
  const found = JSON.parse(localStorage.getItem(key) || "[]").find((r) => r.clientId === clientId);
  return found ? found.記録ID : "";
}

// 生育調査（GAS側 validateGrowth_ / saveGrowth_ と同じロジック）
function mockSaveGrowth(payload) {
  const missing = [];
  if (!payload.surveyDate) missing.push("調査日");
  if (!payload.base) missing.push("拠点");
  const items = payload.items || [];
  if (items.length === 0) missing.push("調査した株（少なくとも1株）");
  else items.forEach((it, i) => { if (!it.label) missing.push((i + 1) + "件目の株ラベル"); });
  if (missing.length > 0) return { ok: false, error: "必須項目が未入力です: " + missing.join("、") };

  const dup = mockFindByClientId(MOCK_GROWTH_KEY, payload.clientId);
  if (dup) return { ok: true, id: dup, duplicate: true };

  const all = JSON.parse(localStorage.getItem(MOCK_GROWTH_KEY) || "[]");
  const id = "mock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const nowStr = nowTimestamp();
  all.push({
    記録ID: id,
    clientId: payload.clientId || "",
    調査日: payload.surveyDate,
    拠点: payload.base,
    "棟・区画": payload.building || "",
    農作物の種類: payload.crop || "",
    記録者: payload.recorder || "",
    userId: payload.userId || "",
    所感: payload.note || "",
    状態: "完了",
    更新日時: nowStr,
    items: items.map((it) => ({
      株ラベル: it.label,
      茎径mm: keepValue(it.stemDiameter),
      生長点花房距離cm: keepValue(it.trussDistance),
      草丈cm: keepValue(it.plantHeight),
      節間長cm: keepValue(it.internodeLength),
      開花段位: keepValue(it.floweringTruss),
      収穫段位: keepValue(it.harvestTruss),
      花房下葉数: keepValue(it.leavesBelowTruss),
      着果数: keepValue(it.fruitSet),
      葉数: keepValue(it.leafCount),
      葉長cm: keepValue(it.leafLength),
      果径mm: keepValue(it.fruitDiameter),
      尻腐れ果数: keepValue(it.blossomEndRot),
      裂果数: keepValue(it.cracking),
      その他障害果数: keepValue(it.otherDisorder),
      障害果メモ: keepValue(it.disorderMemo),
      成長点の形: keepValue(it.growingPoint),
      葉の角度: keepValue(it.leafAngle),
      葉の色: keepValue(it.leafColor),
      花房: keepValue(it.truss),
      メモ: keepValue(it.memo),
    })),
  });
  localStorage.setItem(MOCK_GROWTH_KEY, JSON.stringify(all));
  return { ok: true, id };
}

function mockCancelGrowth(payload) {
  const all = JSON.parse(localStorage.getItem(MOCK_GROWTH_KEY) || "[]");
  const target = all.find((r) => r.記録ID === payload.id);
  if (!target) return { ok: false, error: "対象の記録が見つかりません" };
  if (target.userId !== (payload.userId || "")) return { ok: false, error: "本人の記録のみ取消できます" };
  target.状態 = "取消";
  target.更新日時 = nowTimestamp();
  localStorage.setItem(MOCK_GROWTH_KEY, JSON.stringify(all));
  return { ok: true };
}

function mockSaveWork(payload) {
  if (!payload.base) return { ok: false, error: "拠点を選択してください" };
  if (!payload.workType) return { ok: false, error: "作業分類を選択してください" };

  const dup = mockFindByClientId(MOCK_WORK_KEY, payload.clientId);
  if (dup) return { ok: true, id: dup, duplicate: true };

  const all = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]");
  const id = "mock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const nowStr = nowTimestamp();
  all.push({
    記録ID: id,
    clientId: payload.clientId || "",
    作業日: payload.workDate || formatToday(),
    記録日時: nowStr,
    拠点: payload.base,
    "棟・区画": payload.building || "",
    作業分類: payload.workType,
    作業詳細: payload.workDetail || "",
    開始時刻: payload.startTime || "",
    終了時刻: payload.endTime || "",
    所要時間分: payload.durationMin || "",
    数量: payload.quantity || "",
    数量単位: payload.quantityUnit || "",
    記録者: payload.recorder || "",
    userId: payload.userId || "",
    備考: payload.note || "",
    状態: "完了",
    更新日時: nowStr,
  });
  localStorage.setItem(MOCK_WORK_KEY, JSON.stringify(all));
  return { ok: true, id };
}

function mockUpdateWork(payload) {
  const all = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]");
  const target = all.find((r) => r.記録ID === payload.id);
  if (!target) return { ok: false, error: "対象の記録が見つかりません" };
  if (target.作業日 !== formatToday()) return { ok: false, error: "当日分のみ編集できます" };
  const map = {
    base: "拠点", building: "棟・区画", workType: "作業分類", workDetail: "作業詳細",
    startTime: "開始時刻", endTime: "終了時刻", durationMin: "所要時間分",
    quantity: "数量", quantityUnit: "数量単位", note: "備考",
  };
  Object.keys(map).forEach((k) => {
    if (payload[k] !== undefined) target[map[k]] = payload[k];
  });
  target.更新日時 = nowTimestamp();
  localStorage.setItem(MOCK_WORK_KEY, JSON.stringify(all));
  return { ok: true };
}

// 散布記録は「気軽に残す簡易帳簿」という位置づけ。農薬に限らず葉面散布肥料だけでも記録できる
// （GAS側 validateSpray_ と同じロジック）
function validateSprayPayload(payload) {
  const missing = [];
  if (!payload.useDate) missing.push("使用年月日");
  if (!payload.base) missing.push("使用場所（拠点）");
  if (!payload.crop) missing.push("農作物の種類");
  const items = payload.items || [];
  if (items.length === 0) {
    missing.push("散布する資材（少なくとも1件）");
  } else {
    items.forEach((it, idx) => {
      const n = idx + 1;
      if (!it.materialName && !it.pesticideName) missing.push(n + "件目の資材名");
      const hasDilution = !!it.dilution;
      const hasAmount = !!(it.amount && it.amountUnit);
      if (!hasDilution && !hasAmount) missing.push(n + "件目の希釈倍数または使用量");
    });
  }
  return missing;
}

// 資材名から区分と農薬登録の有無を引く（GAS側 lookupMaterial_ と同じ）
function lookupMaterialMock(name) {
  const list = (getCachedMasters() || MASTERS_DEFAULT).materials || [];
  const m = list.find((x) => x.薬剤名 === name);
  return m
    ? { 区分: m.区分 || "", 農薬登録の有無: m.農薬登録の有無 || "" }
    : { 区分: "", 農薬登録の有無: "" };
}

// 明細の区分から散布区分を決める。展着剤は農薬登録があっても判定に影響させない
// （GAS側 decideSprayType_ と同じ）
function decideSprayTypeMock(itemRows) {
  let hasPest = false;
  let hasFoliar = false;
  itemRows.forEach((it) => {
    const kubun = String(it.区分 || "");
    if (KUBUN_PEST_CONTROL.includes(kubun)) hasPest = true;
    if (KUBUN_FOLIAR.includes(kubun)) hasFoliar = true;
  });
  if (hasPest && hasFoliar) return "防除・葉面散布";
  if (hasPest) return "防除";
  if (hasFoliar) return "葉面散布";
  return "その他";
}

function mockSaveSpray(payload) {
  const missing = validateSprayPayload(payload);
  if (missing.length > 0) return { ok: false, error: "必須項目が未入力です: " + missing.join("、") };

  const dup = mockFindByClientId(MOCK_SPRAY_KEY, payload.clientId);
  if (dup) return { ok: true, id: dup, duplicate: true };

  const all = JSON.parse(localStorage.getItem(MOCK_SPRAY_KEY) || "[]");
  const id = "mock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const nowStr = nowTimestamp();

  const items = payload.items.map((it) => {
    const name = it.materialName || it.pesticideName;
    const master = lookupMaterialMock(name);
    return {
      資材名: name,
      区分: master.区分,
      農薬登録の有無: master.農薬登録の有無,
      希釈倍数: it.dilution || "",
      使用量: it.amount || "",
      使用量単位: it.amountUnit || "",
      "1回使用量": it.perBatch || "",
      散布液量L: it.totalVolumeL || "",
    };
  });

  all.push({
    記録ID: id,
    clientId: payload.clientId || "",
    使用年月日: payload.useDate,
    拠点: payload.base,
    "棟・区画": payload.building || "",
    農作物の種類: payload.crop,
    散布区分: decideSprayTypeMock(items),
    目的タグ: (payload.purposeTags || []).join(PURPOSE_SEPARATOR),
    目的自由入力: payload.purposeFree || "",
    レシピ名: payload.recipeName || "",
    総調製量L: payload.totalVolumeL || "",
    散布方法: payload.method || "",
    "1回調製容量L": payload.batchVolumeL || "",
    調製回数: payload.batchCount || "",
    棟別散布量: payload.volumeByBuilding || "",
    開始時刻: payload.startTime || "",
    終了時刻: payload.endTime || "",
    所要時間分: payload.durationMin || "",
    記録者: payload.recorder || "",
    userId: payload.userId || "",
    備考: payload.note || "",
    // 散布前に作った調製シートは「予定」。散布が済んだら完了にする（GAS側 saveSpray_ と同じ）
    状態: payload.status === "完了" ? "完了" : "予定",
    更新日時: nowStr,
    items,
  });
  localStorage.setItem(MOCK_SPRAY_KEY, JSON.stringify(all));
  return { ok: true, id };
}

// 作業記録の取消。GAS側 cancelRecord_ と同じ条件（本人・当日分のみ）を適用する
function mockCancelWork(payload) {
  const all = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]");
  const target = all.find((r) => r.記録ID === payload.id);
  if (!target) return { ok: false, error: "対象の記録が見つかりません" };
  if (target.userId !== (payload.userId || "")) return { ok: false, error: "本人の記録のみ取消できます" };
  if (target.作業日 !== formatToday()) return { ok: false, error: "当日分のみ取消できます" };
  target.状態 = "取消";
  target.更新日時 = nowTimestamp();
  localStorage.setItem(MOCK_WORK_KEY, JSON.stringify(all));
  return { ok: true };
}

// 散布が済んだ「予定」を「完了」にする（GAS側 completeSpray_ と同じ）
function mockCompleteSpray(payload) {
  const all = JSON.parse(localStorage.getItem(MOCK_SPRAY_KEY) || "[]");
  const target = all.find((r) => r.記録ID === payload.id);
  if (!target) return { ok: false, error: "対象の記録が見つかりません" };
  if (target.userId !== (payload.userId || "")) return { ok: false, error: "本人の記録のみ確定できます" };
  target.状態 = "完了";
  if (payload.startTime !== undefined) target.開始時刻 = payload.startTime;
  if (payload.endTime !== undefined) target.終了時刻 = payload.endTime;
  target.更新日時 = nowTimestamp();
  localStorage.setItem(MOCK_SPRAY_KEY, JSON.stringify(all));
  return { ok: true };
}

// 散布記録の取消。簡易帳簿として運用するため理由は求めない（本人チェックのみ）
function mockCancelSpray(payload) {
  const all = JSON.parse(localStorage.getItem(MOCK_SPRAY_KEY) || "[]");
  const target = all.find((r) => r.記録ID === payload.id);
  if (!target) return { ok: false, error: "対象の記録が見つかりません" };
  if (target.userId !== (payload.userId || "")) return { ok: false, error: "本人の記録のみ取消できます" };
  target.状態 = "取消";
  target.更新日時 = nowTimestamp();
  localStorage.setItem(MOCK_SPRAY_KEY, JSON.stringify(all));
  return { ok: true };
}

function inRange(dateStr, params) {
  if (params.from && dateStr < params.from) return false;
  if (params.to && dateStr > params.to) return false;
  return true;
}

// ---------- マスタ参照（拠点→棟の2段選択で work.js / pesticide.js 共通に使う） ----------

function activeBases(masters) {
  const seen = new Set();
  const list = [];
  (masters.bases || [])
    .filter((b) => String(b.有効フラグ).toUpperCase() === "TRUE")
    .sort((a, b) => Number(a.表示順) - Number(b.表示順))
    .forEach((b) => {
      if (!seen.has(b.拠点名)) {
        seen.add(b.拠点名);
        list.push(b.拠点名);
      }
    });
  return list;
}

function buildingsOfBase(masters, baseName) {
  return (masters.bases || [])
    .filter((b) => b.拠点名 === baseName && String(b.有効フラグ).toUpperCase() === "TRUE")
    .sort((a, b) => Number(a.表示順) - Number(b.表示順));
}

function mockGet(action, params) {
  const today = formatToday();

  if (action === "masters") return Object.assign({ ok: true }, MASTERS_DEFAULT);

  if (action === "records") {
    const all = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]");
    let records = all.filter((r) => r.状態 !== "取消" && inRange(r.作業日, params));
    if (params.base) records = records.filter((r) => r.拠点 === params.base);
    return { ok: true, records: records.slice().reverse() };
  }

  if (action === "sprays" || action === "pesticides") {
    const all = JSON.parse(localStorage.getItem(MOCK_SPRAY_KEY) || "[]");
    let records = all.filter((r) => r.状態 !== "取消" && inRange(r.使用年月日, params));
    if (params.base) records = records.filter((r) => r.拠点 === params.base);
    return { ok: true, records: records.slice().reverse() };
  }

  if (action === "mytoday") {
    const uid = params.userId;
    const work = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]")
      .filter((r) => r.作業日 === today && r.userId === uid && r.状態 !== "取消");
    const spray = JSON.parse(localStorage.getItem(MOCK_SPRAY_KEY) || "[]")
      .filter((r) => r.使用年月日 === today && r.userId === uid && r.状態 !== "取消");
    const growth = JSON.parse(localStorage.getItem(MOCK_GROWTH_KEY) || "[]")
      .filter((r) => r.調査日 === today && r.userId === uid && r.状態 !== "取消");
    return { ok: true, work, spray, pesticide: spray, growth };
  }

  if (action === "growths") {
    const all = JSON.parse(localStorage.getItem(MOCK_GROWTH_KEY) || "[]");
    let records = all.filter((r) => r.状態 !== "取消" && inRange(r.調査日, params));
    if (params.base) records = records.filter((r) => r.拠点 === params.base);
    return { ok: true, records: records.slice().reverse() };
  }

  // 同じ場所の直近の調査を1件返す（前回値と伸長量の表示に使う）
  if (action === "lastGrowth") {
    const all = JSON.parse(localStorage.getItem(MOCK_GROWTH_KEY) || "[]");
    const before = params.before || "9999-99-99";
    const cands = all.filter((r) =>
      r.状態 !== "取消" &&
      (!params.base || r.拠点 === params.base) &&
      (!params.building || r["棟・区画"] === params.building) &&
      r.調査日 < before);
    cands.sort((a, b) => (a.調査日 < b.調査日 ? 1 : -1));
    return { ok: true, growth: cands[0] || null };
  }

  if (action === "history") {
    const days = Number(params.days) || 14;
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceKey = formatDate(since);
    const work = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]")
      .filter((r) => r.状態 !== "取消" && r.作業日 >= sinceKey)
      .map((r) => Object.assign({ _type: "work" }, r));
    const spray = JSON.parse(localStorage.getItem(MOCK_SPRAY_KEY) || "[]")
      .filter((r) => r.状態 !== "取消" && r.使用年月日 >= sinceKey)
      .map((r) => Object.assign({ _type: "spray" }, r));
    const growth = JSON.parse(localStorage.getItem(MOCK_GROWTH_KEY) || "[]")
      .filter((r) => r.状態 !== "取消" && r.調査日 >= sinceKey)
      .map((r) => Object.assign({ _type: "growth" }, r));
    const dateOf = (o) => (o._type === "work" ? o.作業日 : o._type === "growth" ? o.調査日 : o.使用年月日);
    const items = work.concat(spray, growth).sort((a, b) => {
      const da = dateOf(a);
      const db = dateOf(b);
      return da < db ? 1 : da > db ? -1 : 0;
    });
    return { ok: true, items };
  }

  // 法定帳簿。農薬登録のある資材の行だけを抜き出す（GAS側 getLegalLedger_ と同じ）。
  // まいていない「予定」は帳簿に出さない
  if (action === "legalLedger") {
    const all = JSON.parse(localStorage.getItem(MOCK_SPRAY_KEY) || "[]");
    const rows = [];
    all.filter((r) => r.状態 !== "取消" && r.状態 !== "予定" && inRange(r.使用年月日, params)).forEach((parent) => {
      (parent.items || []).forEach((it) => {
        if (String(it.農薬登録の有無).toUpperCase() !== "TRUE") return;
        rows.push({
          使用年月日: parent.使用年月日,
          使用場所: parent.拠点 + (parent["棟・区画"] ? " / " + parent["棟・区画"] : ""),
          農作物の種類: parent.農作物の種類,
          農薬の名称: it.資材名,
          希釈倍数: it.希釈倍数,
          使用量: it.使用量,
          使用量単位: it.使用量単位,
          散布液量L: it.散布液量L,
          "対象病害虫・目的": [parent.目的タグ, parent.目的自由入力].filter(String).join(PURPOSE_SEPARATOR),
          作業者: parent.記録者,
          記録ID: parent.記録ID,
        });
      });
    });
    return { ok: true, rows };
  }

  if (action === "weather") return { ok: true, weather: null };
  if (action === "weatherRange") return { ok: true, items: [] };

  return { ok: true };
}
