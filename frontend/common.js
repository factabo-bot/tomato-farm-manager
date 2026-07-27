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

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
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

async function apiGet(action, params) {
  if (isMock) return mockGet(action, params || {});
  const qs = new URLSearchParams(Object.assign({ action }, params || {}, { _: Date.now() }));
  const res = await fetch(CONFIG.GAS_URL + "?" + qs.toString());
  return res.json();
}

// Content-Type: text/plain にするとCORSのプリフライトが発生しない（GASの定石）
async function apiPost(payload) {
  if (CONFIG.APP_TOKEN) payload.token = CONFIG.APP_TOKEN;
  if (isMock) return mockPost(payload);
  const res = await fetch(CONFIG.GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ---------- マスタのキャッシュ ----------
// GASのAPIは応答に5秒前後かかる（Apps Script側の構造的な遅さ）。
// マスタは滅多に変わらないので、前回取得した内容をlocalStorageに残しておき、
// 画面は即座にそれで描画してから、裏で最新版を取りに行く。

const MASTERS_CACHE_KEY = "tfm_masters_cache";

function getCachedMasters() {
  try {
    const raw = localStorage.getItem(MASTERS_CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.warn("マスタキャッシュの読み込みに失敗", err);
  }
  return null;
}

function saveMastersCache(masters) {
  try {
    localStorage.setItem(MASTERS_CACHE_KEY, JSON.stringify(masters));
  } catch (err) {
    console.warn("マスタキャッシュの保存に失敗", err);
  }
}

// キャッシュがあれば待たずにそれを返し、裏で最新版を取得する。
// 取得結果がキャッシュと違っていたときだけ onFresh(最新マスタ) が呼ばれる
// （利用者が入力中に画面が作り替わるのを避けるため、変化がなければ何もしない）。
// キャッシュがない初回だけは取得を待つ。
async function loadMasters(onFresh) {
  const cached = getCachedMasters();

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

// オフライン等でsubmitが失敗したときに使う。送信キューに積んで later flush する
async function apiPostWithQueue(payload) {
  if (CONFIG.APP_TOKEN) payload.token = CONFIG.APP_TOKEN;
  if (isMock) return mockPost(payload);
  try {
    const res = await fetch(CONFIG.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    });
    return await res.json();
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
      const res = await fetch(CONFIG.GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(item.payload),
      });
      const data = await res.json();
      if (data.ok) sentCount++;
      else remain.push(item);
    } catch (err) {
      remain.push(item); // まだオフライン。残す
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remain));
  updateQueueBadge();
  if (sentCount > 0) toast(`保留中だった記録 ${sentCount}件を送信しました`);
}

function updateQueueBadge() {
  const badge = $("queue-badge");
  if (!badge) return;
  const n = queueLength();
  badge.hidden = n === 0;
  badge.textContent = `📤 未送信 ${n}件`;
}

window.addEventListener("online", flushQueue);
window.addEventListener("DOMContentLoaded", () => {
  flushQueue();
  updateQueueBadge();
});

// ---------- お試しモード（GAS未接続。localStorageのみで動く） ----------

const MOCK_WORK_KEY = "tfm_mock_work";
const MOCK_PESTICIDE_KEY = "tfm_mock_pesticide";

function mockPost(payload) {
  if (payload.type === "pesticide") return mockSavePesticide(payload);
  if (payload.type === "cancelRecord") return mockCancelWork(payload);
  if (payload.type === "cancelPesticide") return mockCancelPesticide(payload);
  if (payload.type === "updateRecord") return mockUpdateWork(payload);
  return mockSaveWork(payload);
}

function mockSaveWork(payload) {
  if (!payload.base) return { ok: false, error: "拠点を選択してください" };
  if (!payload.workType) return { ok: false, error: "作業分類を選択してください" };
  const all = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]");
  const id = "mock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const nowStr = nowTimestamp();
  all.push({
    記録ID: id,
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

// 防除記録は「気軽に残す簡易帳簿」という位置づけ。法定5項目のうち
// 農薬名・使用量/希釈倍数は明細（items）側でチェックする（GAS側 validatePesticide_ と同じロジック）
function validatePesticidePayload(payload) {
  const missing = [];
  if (!payload.useDate) missing.push("使用年月日");
  if (!payload.base) missing.push("使用場所（拠点）");
  if (!payload.crop) missing.push("農作物の種類");
  const items = payload.items || [];
  if (items.length === 0) {
    missing.push("農薬（少なくとも1件）");
  } else {
    items.forEach((it, idx) => {
      const n = idx + 1;
      if (!it.pesticideName) missing.push(n + "件目の農薬名");
      const hasDilution = !!it.dilution;
      const hasAmount = !!(it.amount && it.amountUnit);
      if (!hasDilution && !hasAmount) missing.push(n + "件目の希釈倍数または使用量");
    });
  }
  return missing;
}

function mockSavePesticide(payload) {
  const missing = validatePesticidePayload(payload);
  if (missing.length > 0) return { ok: false, error: "必須項目が未入力です: " + missing.join("、") };
  const all = JSON.parse(localStorage.getItem(MOCK_PESTICIDE_KEY) || "[]");
  const id = "mock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const nowStr = nowTimestamp();
  all.push({
    記録ID: id,
    使用年月日: payload.useDate,
    拠点: payload.base,
    "棟・区画": payload.building || "",
    農作物の種類: payload.crop,
    対象病害虫: payload.targetPest || "",
    レシピ名: payload.recipeName || "",
    記録者: payload.recorder || "",
    userId: payload.userId || "",
    備考: payload.note || "",
    状態: "完了",
    更新日時: nowStr,
    items: payload.items.map((it) => ({
      薬剤名: it.pesticideName,
      希釈倍数: it.dilution || "",
      使用量: it.amount || "",
      使用量単位: it.amountUnit || "",
      散布液量L: it.totalVolumeL || "",
    })),
  });
  localStorage.setItem(MOCK_PESTICIDE_KEY, JSON.stringify(all));
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

// 防除記録の取消。簡易帳簿として運用するため理由は求めない（本人チェックのみ）
function mockCancelPesticide(payload) {
  const all = JSON.parse(localStorage.getItem(MOCK_PESTICIDE_KEY) || "[]");
  const target = all.find((r) => r.記録ID === payload.id);
  if (!target) return { ok: false, error: "対象の記録が見つかりません" };
  if (target.userId !== (payload.userId || "")) return { ok: false, error: "本人の記録のみ取消できます" };
  target.状態 = "取消";
  target.更新日時 = nowTimestamp();
  localStorage.setItem(MOCK_PESTICIDE_KEY, JSON.stringify(all));
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

  if (action === "pesticides") {
    const all = JSON.parse(localStorage.getItem(MOCK_PESTICIDE_KEY) || "[]");
    let records = all.filter((r) => r.状態 !== "取消" && inRange(r.使用年月日, params));
    if (params.base) records = records.filter((r) => r.拠点 === params.base);
    return { ok: true, records: records.slice().reverse() };
  }

  if (action === "mytoday") {
    const uid = params.userId;
    const work = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]")
      .filter((r) => r.作業日 === today && r.userId === uid && r.状態 !== "取消");
    const pesticide = JSON.parse(localStorage.getItem(MOCK_PESTICIDE_KEY) || "[]")
      .filter((r) => r.使用年月日 === today && r.userId === uid && r.状態 !== "取消");
    return { ok: true, work, pesticide };
  }

  if (action === "history") {
    const days = Number(params.days) || 14;
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceKey = formatDate(since);
    const work = JSON.parse(localStorage.getItem(MOCK_WORK_KEY) || "[]")
      .filter((r) => r.状態 !== "取消" && r.作業日 >= sinceKey)
      .map((r) => Object.assign({ _type: "work" }, r));
    const pesticide = JSON.parse(localStorage.getItem(MOCK_PESTICIDE_KEY) || "[]")
      .filter((r) => r.状態 !== "取消" && r.使用年月日 >= sinceKey)
      .map((r) => Object.assign({ _type: "pesticide" }, r));
    const items = work.concat(pesticide).sort((a, b) => {
      const da = a._type === "work" ? a.作業日 : a.使用年月日;
      const db = b._type === "work" ? b.作業日 : b.使用年月日;
      return da < db ? 1 : da > db ? -1 : 0;
    });
    return { ok: true, items };
  }

  if (action === "weather") return { ok: true, weather: null };
  if (action === "weatherRange") return { ok: true, items: [] };

  return { ok: true };
}
