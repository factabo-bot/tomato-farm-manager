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

const readsInFlight = new Map();
function apiGet(action, params) {
  const key = JSON.stringify([action, params || {}]);
  if (readsInFlight.has(key)) return readsInFlight.get(key);
  const pending = apiGetNetwork(action, params).finally(() => readsInFlight.delete(key));
  readsInFlight.set(key, pending);
  return pending;
}

async function apiGetNetwork(action, params) {
  if (isMock) return mockGet(action, params || {});
  let lastErr = null;
  for (let i = 0; i < GET_TRIES; i++) {
    if (i > 0) await sleep(400 * i);
    try {
      const qs = new URLSearchParams(Object.assign({ action }, params || {}, { _: Date.now() }));
      if (!navigator.onLine) return { ok: false, error: "オフラインです" };
      const res = await fetchWithTimeout(CONFIG.GAS_URL + "?" + qs.toString());
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

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    // 本文を受け取るまでタイムアウトを有効にする。
    const text = await response.text();
    return { ok: response.ok, status: response.status, redirected: response.redirected, text: async () => text };
  } finally { clearTimeout(timer); }
}

function postError(message, safeToRetry) {
  const err = new Error(message);
  err.safeToRetry = safeToRetry;
  return err;
}

// Content-Type: text/plain にするとCORSのプリフライトが発生しない（GASの定石）
async function postOnce(payload) {
  const res = await fetchWithTimeout(CONFIG.GAS_URL, {
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
// 画面を開くたびの重複取得を避ける。
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
      if (changed && onFresh) onFresh(fresh);
      return fresh;
    })
    .catch((err) => {
      console.warn("マスタの取得に失敗（キャッシュで継続）", err);
      return null;
    });

  if (cached) return cached;
  // 初回も同梱の候補で入力を始められる。取得できたら候補を更新する。
  return Object.assign({ ok: true }, MASTERS_DEFAULT);
}

// スプレッドシート側のマスタを直したのに画面が古いまま、というときに使う。
// 上の1時間を待たずに済ませたいだけなので、キャッシュを捨ててから取り直す
async function refreshMasters() {
  const fresh = await apiGet("masters");
  if (!fresh || !fresh.ok) throw new Error("マスタを取得できませんでした");
  saveMastersCache(fresh);
  return fresh;
}

// ---------- 使用回数の集計 ----------
// 農薬には「本剤を何回まで」と「同じ成分を含む農薬を通算で何回まで」の2つの枠があり、
// 後者は製品が違っても足し算される（TPNを含むダコニール1000・フォリオゴールド・
// アミスターオプティを別々に数えると超える）。ここでは両方と、抵抗性管理のための
// 作用機構コード（IRAC/FRAC）の回数を、棟ごとに数える。
// 作の区切りはマスタ_拠点棟の「現作の開始日」。空なら全期間を数える。

function splitBuildings(value) {
  return String(value || "").split(/[、,]/).map((s) => s.trim()).filter(Boolean);
}

// 「11/M5」のようにコードが複数ある混合剤を分ける
function splitCodes(value) {
  return String(value || "").split(/[/／、,]/).map((s) => s.trim()).filter(Boolean);
}

// 「TPN:6」「メタラキシルM:4/TPN:6」を [{ name, limit }] にする。
// 回数が書かれていなければ limit は null（＝数えるが上限は判定しない）
function parseIngredientLimits(value) {
  return splitCodes(value).map((part) => {
    const i = part.lastIndexOf(":");
    if (i < 0) return { name: part, limit: null };
    const limit = Number(part.slice(i + 1).replace(/[^0-9]/g, ""));
    return { name: part.slice(0, i).trim(), limit: limit || null };
  }).filter((x) => x.name);
}

function cropStartOf(masters, baseName, buildingName) {
  const row = (masters.bases || []).find((b) =>
    b.拠点名 === baseName && String(b.棟区画名 || "") === String(buildingName || ""));
  return row ? String(row["現作の開始日"] || "").slice(0, 10) : "";
}

// 1棟分の集計。散布記録の「棟・区画」は「1号棟、2号棟」のように複数入るので分解して照合する
function countSprayUsage(records, masters, baseName, buildingName) {
  const since = cropStartOf(masters, baseName, buildingName);
  const byMaterial = {};
  const byIngredient = {};
  const byIrac = {};
  const byFrac = {};
  const materials = masters.materials || [];

  (records || []).forEach((rec) => {
    if (rec.状態 === "取消" || rec.状態 === "予定") return;
    if (rec.拠点 !== baseName) return;
    if (since && String(rec.使用年月日 || "").slice(0, 10) < since) return;

    const builds = splitBuildings(rec["棟・区画"]);
    // 棟を持たない拠点は、棟名も空どうしで照合する
    const hit = builds.length
      ? builds.indexOf(String(buildingName || "")) >= 0
      : String(buildingName || "") === "";
    if (!hit) return;

    (rec.items || []).forEach((it) => {
      const name = String(it.資材名 || "");
      if (!name) return;
      const m = materials.find((x) => x.薬剤名 === name);
      // 肥料には使用回数の制限がない。記録した時点の値を先に見る（マスタは後から変わりうる）
      const registered = String(
        it["農薬登録の有無"] !== undefined && it["農薬登録の有無"] !== ""
          ? it["農薬登録の有無"]
          : (m ? m.農薬登録の有無 : "")
      ).toUpperCase() === "TRUE";
      if (!registered) return;

      byMaterial[name] = (byMaterial[name] || 0) + 1;
      if (!m) return;
      parseIngredientLimits(m["成分と通算回数"]).forEach((g) => {
        byIngredient[g.name] = (byIngredient[g.name] || 0) + 1;
      });
      splitCodes(m["IRACコード"]).forEach((c) => { byIrac[c] = (byIrac[c] || 0) + 1; });
      splitCodes(m["FRACコード"]).forEach((c) => { byFrac[c] = (byFrac[c] || 0) + 1; });
    });
  });

  return { since, materials: byMaterial, ingredients: byIngredient, irac: byIrac, frac: byFrac };
}

// 複数の棟に撒くときは、いちばん使っている棟に合わせる（超える棟を見落とさないため）
function mergeSprayUsage(list) {
  const out = { since: "", materials: {}, ingredients: {}, irac: {}, frac: {} };
  (list || []).forEach((u) => {
    if (u.since && (!out.since || u.since < out.since)) out.since = u.since;
    ["materials", "ingredients", "irac", "frac"].forEach((k) => {
      Object.keys(u[k]).forEach((name) => {
        out[k][name] = Math.max(out[k][name] || 0, u[k][name]);
      });
    });
  });
  return out;
}

// 1剤ぶんの「あと何回使えるか」。上限が分かっていない項目は判定しない
function usageStatusOf(material, usage) {
  if (!material || !usage) return null;
  const used = usage.materials[material.薬剤名] || 0;
  const limit = Number(String(material["本剤の使用回数"] || "").replace(/[^0-9]/g, "")) || null;
  const overs = [];
  parseIngredientLimits(material["成分と通算回数"]).forEach((g) => {
    const n = usage.ingredients[g.name] || 0;
    if (g.limit && n >= g.limit) overs.push(g.name + " 通算" + n + "/" + g.limit);
  });
  const full = (limit && used >= limit) || overs.length > 0;
  return { used, limit, overs, full };
}

// 散布記録は取得が重いので、拠点ごとに少しの間だけ手元に置く
const SPRAY_HISTORY_CACHE_KEY = "tfm_spray_history_cache";
const SPRAY_HISTORY_TTL_MS = 10 * 60 * 1000;

function readSprayHistoryCache(baseName) {
  try {
    const all = JSON.parse(localStorage.getItem(SPRAY_HISTORY_CACHE_KEY) || "{}");
    return all[baseName] || null;
  } catch (err) {
    return null;
  }
}

function saveSprayHistoryCache(baseName, records) {
  try {
    const all = JSON.parse(localStorage.getItem(SPRAY_HISTORY_CACHE_KEY) || "{}");
    all[baseName] = { savedAt: Date.now(), records };
    localStorage.setItem(SPRAY_HISTORY_CACHE_KEY, JSON.stringify(all));
  } catch (err) {
    console.warn("散布履歴の保存に失敗", err);
  }
}

// キャッシュがあれば待たずに返し、裏で取り直す。取れたら onFresh(records) を呼ぶ
async function loadSprayHistory(baseName, onFresh) {
  const cached = readSprayHistoryCache(baseName);
  const withLocal = (records, savedAt) => mergeRemoteRecords(
    storeRead("spray").filter((r) => r.拠点 === baseName), records, savedAt);
  if (cached && Date.now() - cached.savedAt < SPRAY_HISTORY_TTL_MS) return withLocal(cached.records, cached.savedAt);

  const startedAt = Date.now();
  const fetching = apiGet("sprays", { base: baseName })
    .then((res) => {
      if (!res || !res.ok) return null;
      const records = res.records || [];
      saveSprayHistoryCache(baseName, records);
      const merged = withLocal(records, startedAt);
      if (cached && onFresh) onFresh(merged);
      return merged;
    })
    .catch((err) => {
      console.warn("散布履歴の取得に失敗（手元の分で続ける）", err);
      return null;
    });

  if (cached) return withLocal(cached.records, cached.savedAt);
  return (await fetching) || [];
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
    toast("端末に保存できませんでした。空き容量を確認してください");
    throw err;
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
function storeAdd(kind, record, payload) {
  record._localChangedAt = Date.now();
  const store = readStore();
  store[kind] = (store[kind] || []).concat([record]);
  writeStore(store);
  if (payload && !isMock) {
    try {
      if (CONFIG.APP_TOKEN) payload.token = CONFIG.APP_TOKEN;
      enqueue(payload);
    } catch (err) {
      store[kind] = store[kind].filter((r) => r !== record);
      writeStore(store);
      toast("再送用の保存ができませんでした。入力を残しています");
      throw err;
    }
  }
}

// 同じ記録を差し替える。無ければ何もしない
function storePatch(kind, key, patch) {
  const store = readStore();
  store[kind] = (store[kind] || []).map((r) => (recordKey(r) === key ? Object.assign({}, r, patch, { _localChangedAt: Date.now() }) : r));
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
    store[kind] = (store[kind] || []).filter((r) => !r.記録ID || recordDate(kind, r) >= limitKey);
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
  const current = storeRead(kind).find((r) => r.記録ID === id);
  if (current && current._version) payload.expectedVersion = current._version;
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
  const current = storeRead(kind).find((r) => r.記録ID === id);
  if (current && current._version) payload.expectedVersion = current._version;
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
  writeQueue(readQueue().filter((item) => {
    if ((item.payload || {}).clientId !== clientId) return true;
    // 一度でも送信を試したものはサーバーに届いている可能性がある。
    // IDを確認してから取消を送る（画面を閉じてもこの意図を残す）。
    if (item.attempted) { item.cancelRequested = true; return true; }
    return false;
  }));
}

// ---------- 同期 ----------
// ① 溜まっている送信を出す ② サーバーの内容を取り込む、の順で回す。
// スプレッドシートは台帳として直接編集されるので、②は必須（送るだけでは足りない）

let syncing = false;
let syncLabel = "";
let syncError = "";
const SYNC_INTERVAL_MS = 60 * 1000;

// お試しモードでも同じ道を通す（mockGet/mockPostがサーバーの代わりになる）
async function sync(onChange, force) {
  if (syncing) return;
  if (!navigator.onLine && !isMock) { updateQueueBadge(); return; }
  if (!force && !queueLength() && Date.now() - readStore().syncedAt < SYNC_INTERVAL_MS) return;
  syncing = true;
  syncError = "";
  syncLabel = "同期中…";
  updateQueueBadge();
  try {
    await flushQueue();
    const changed = await pullRecords();
    if (changed && onChange) onChange();
  } catch (err) {
    console.warn("同期に失敗", err);
    syncError = "同期できませんでした。端末の記録を表示中";
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
  const startedAt = Date.now();
  if (!isMock) {
    const beforeStore = readStore();
    const response = await apiGet("sync", { cursor: beforeStore.cursor || "" });
    if (response && response.ok && response.protocol === 1) {
      return applySyncResponse(response, beforeStore, startedAt);
    }
    // GASの更新前だけ旧APIで取り込む。失敗を空データとして保存しない。
    if (!response || response.message !== GET_GREETING) throw new Error("同期を取得できませんでした");
  }
  const since = new Date();
  since.setDate(since.getDate() - STORE_DAYS);
  const [res, weatherRes] = await Promise.all([
    apiGet("history", { days: STORE_DAYS }),
    apiGet("weatherRange", { from: formatDate(since), to: formatToday() }),
  ]);
  if (!res || !res.ok) throw new Error("記録を取得できませんでした");

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
    store[kind] = mergeRemoteRecords(store[kind] || [], fetched[kind], startedAt);
  });
  storePrune(store);
  if (!weatherRes || !weatherRes.ok) throw new Error("気象データを取得できませんでした");
  store.cursor = "";
  store.syncedAt = Date.now();
  writeStore(store);

  return JSON.stringify([KINDS.map((k) => store[k] || []), store.weather || []]) !== before;
}

function applySyncResponse(response, previous, startedAt) {
  if (!Array.isArray(response.items) || !Array.isArray(response.deleted)) throw new Error("同期応答が不正です");
  const store = readStore();
  // 別タブが先に取り込み済みなら、古いカーソルの応答で巻き戻さない。
  if (store.cursor !== previous.cursor || store.syncedAt !== previous.syncedAt) return false;
  const before = JSON.stringify(store);
  const keyOf = (kind, r) => kind + ":" + (kind === "weather" ? String(r.日付 || "").slice(0, 10) : r.記録ID);
  KINDS.concat(["weather"]).forEach((kind) => {
    const map = new Map();
    if (!response.full) (previous[kind] || []).filter((r) => kind === "weather" || r.記録ID)
      .forEach((r) => map.set(keyOf(kind, r), r));
    response.deleted.forEach((key) => map.delete(key));
    response.items.filter((r) => r._type === kind).forEach((r) => map.set(keyOf(kind, r), r));
    const remote = [...map.values()];
    store[kind] = kind === "weather" ? remote : mergeRemoteRecords(store[kind] || [], remote, startedAt);
  });
  storePrune(store);
  // 応答より新しい端末変更を残した場合、次回は全量で版情報まで確定する。
  // 差分カーソルだけ進めると、変更なしの行の版が古いまま残るため。
  const changedDuringRead = KINDS.some((kind) => (store[kind] || []).some((r) => r._localChangedAt >= startedAt));
  store.cursor = changedDuringRead ? "" : response.cursor;
  store.syncedAt = Date.now();
  writeStore(store);
  return JSON.stringify(store) !== before;
}

// 通信中に入力された行・未送信の変更を、古い応答で消さない。
function mergeRemoteRecords(local, remote, startedAt) {
  const queue = readQueue();
  const protectedRows = local.filter((r) => r._localChangedAt >= startedAt ||
    queue.some((q) => q.payload.id === r.記録ID && !!r.記録ID ||
      q.payload.clientId === r.clientId && !!r.clientId));
  const same = (a, b) => (a.記録ID && a.記録ID === b.記録ID) || (a.clientId && a.clientId === b.clientId);
  const pending = local.filter((r) => !r.記録ID && !remote.some((s) => same(r, s)) &&
    !protectedRows.includes(r) && r.状態 !== "取消");
  return remote.filter((r) => !protectedRows.some((s) => same(r, s))).concat(protectedRows, pending);
}

// オフライン等でsubmitが失敗したときに使う。送信キューに積んで later flush する
async function apiPostWithQueue(payload) {
  if (CONFIG.APP_TOKEN) payload.token = CONFIG.APP_TOKEN;
  if (isMock) return mockPost(payload);
  // 通信より先に永続化する。画面遷移で通信が切れても再送できる。
  const item = enqueue(payload);
  const results = await flushQueue();
  return (results && results[queueKey(item)]) || { ok: true, queued: true };
}

// ---------- 送信キュー（電波が弱いハウス内でも記録できるようにする） ----------

const QUEUE_KEY = "tfm_pending_queue";

function enqueue(payload) {
  const q = readQueue();
  const existing = q.find((x) => payload.clientId && x.payload.clientId === payload.clientId && x.payload.type === payload.type);
  if (existing) return existing;
  const item = { payload, savedAt: Date.now(), queueId: newClientId() };
  q.push(item);
  writeQueue(q);
  return item;
}

function queueLength() {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]").length;
}

let flushing = null;
function flushQueue() {
  if (flushing) return flushing;
  const run = () => flushQueueUnlocked();
  flushing = (navigator.locks ? navigator.locks.request("tfm-send", run) : run())
    .finally(() => { flushing = null; });
  return flushing;
}

async function flushQueueUnlocked() {
  if (isMock) return;
  if (!navigator.onLine) return;
  const results = {};
  const visited = new Set();
  let sentCount = 0;
  while (navigator.onLine) {
    const queued = readQueue();
    const item = queued.find((x, i) => !visited.has(queueKey(x)) && !x.blocked &&
      !queued.slice(0, i).some((older) => sameQueueTarget(older.payload, x.payload)));
    if (!item) break;
    const key = queueKey(item);
    visited.add(key);
    updateQueueItem(key, { attempted: true });
    try {
      const data = await postWithRetry(item.payload);
      results[key] = data;
      if (data.ok) {
        sentCount++;
        const current = readQueue().find((x) => queueKey(x) === key);
        acknowledgeQueued(item.payload, data, current && current.cancelRequested);
        if (current && current.cancelRequested && data.id) {
          enqueue({ type: cancelType(payloadKind(item.payload)), id: data.id, userId: item.payload.userId,
            token: item.payload.token });
        }
        // 最新キューからこの1件だけ削除する。送信中に増えた記録を消さない。
        writeQueue(readQueue().filter((x) => queueKey(x) !== key));
      } else {
        updateQueueItem(key, { lastError: data.error || "サーバーが受け付けませんでした", blocked: !!data.conflict });
      }
    } catch (err) {
      updateQueueItem(key, { lastError: err.message || "通信できませんでした" });
      break; // 通信不調時に全件ぶん待たない。次の同期で同じIDで再送する。
    }
  }
  updateQueueBadge();
  if (onStoreChange) onStoreChange();
  window.dispatchEvent(new Event("tfm-sent"));
  if (sentCount > 0) toast(`保留中だった記録 ${sentCount}件を送信しました`);
  return results;
}

function sameQueueTarget(a, b) {
  if (a.type === "feedLog" && b.type === "feedLog") return a.feedDate === b.feedDate;
  return !!a.id && a.id === b.id;
}

function updateQueueItem(key, patch) {
  writeQueue(readQueue().map((x) => queueKey(x) === key ? Object.assign({}, x, patch) : x));
}

function acknowledgeQueued(payload, data, cancelled) {
  if (payload.type === "feedLog") {
    const rows = JSON.parse(localStorage.getItem("tfm_feed_logs") || "[]");
    rows.forEach((r) => {
      if (r.clientId === payload.clientId) Object.assign(r, { 記録ID: data.id, 状態: "完了", _localChangedAt: Date.now() });
    });
    localStorage.setItem("tfm_feed_logs", JSON.stringify(rows));
  } else {
    storeMarkSynced(payloadKind(payload), payload.clientId, data.id, cancelled ? "取消" : syncedStatus(payload));
    if (payload.id) {
      const kind = /Spray|Pesticide/.test(payload.type) ? "spray" : /Growth/.test(payload.type) ? "growth" : "work";
      const row = storeRead(kind).find((r) => r.記録ID === payload.id);
      if (row) storePatch(kind, recordKey(row), { _awaitingRefresh: true });
    }
  }
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
  } else if (!navigator.onLine && !isMock) {
    badge.textContent = "オフライン・端末の記録を表示中";
  } else if (syncLabel) {
    badge.textContent = "🔄 " + syncLabel;
  } else {
    const at = readStore().syncedAt;
    badge.textContent = syncError || (at ? "✓ 最終同期 " + formatDate(new Date(at)) + " " + timeLabel(new Date(at).toTimeString()) : "未同期・初回データを取得中");
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
  return item.queueId || (item.savedAt || 0) + "|" + JSON.stringify(item.payload || {});
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
  if (payload.type === "feedLog") {
    return `🧫 ${payload.feedDate || ""} / 給液 ${payload.feedL || "?"}L・排液EC ${payload.drainEc || "?"}`;
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
      if (item.attempted && !item.blocked) {
        toast("送信結果が未確認です。記録一覧の取消を使ってください");
        return;
      }
      writeQueue(readQueue().filter((x) => queueKey(x) !== key));
      const store = readStore();
      KINDS.forEach((kind) => {
        store[kind] = (store[kind] || []).filter((r) => !(item.payload.clientId && r.clientId === item.payload.clientId));
        store[kind].forEach((r) => { if (item.payload.id === r.記録ID) r._localChangedAt = 0; });
      });
      // 取り下げた楽観更新を、サーバーの全量で復元する。
      store.cursor = "";
      writeStore(store);
      syncNow(true);
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

function syncNow(force) {
  return sync(() => { if (onStoreChange) onStoreChange(); }, force === true);
}

window.addEventListener("online", syncNow);
window.addEventListener("offline", updateQueueBadge);
window.addEventListener("storage", (event) => {
  if (event.key === STORE_KEY || event.key === QUEUE_KEY) {
    updateQueueBadge();
    if (onStoreChange) onStoreChange();
  }
});
setInterval(() => {
  if (document.visibilityState === "visible") syncNow();
}, SYNC_INTERVAL_MS);
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncNow(); // アプリに戻ったとき
});
window.addEventListener("DOMContentLoaded", () => {
  updateQueueBadge();
  const badge = $("queue-badge");
  if (badge && !$("sync-now")) {
    const button = el("button", "btn-secondary", "今すぐ同期");
    button.id = "sync-now";
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await syncNow(true); } finally { button.disabled = false; }
    });
    badge.insertAdjacentElement("afterend", button);
  }
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
