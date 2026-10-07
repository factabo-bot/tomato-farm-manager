"use strict";

const state = {
  masters: null,
  tab: "work",
  benchBuilding: null, // 「列の経過」で見ている棟
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  const profile = getProfile();
  $("user-info").textContent = profile.displayName + (isMock ? "（お試しモード）" : "");

  const from = new Date();
  from.setDate(from.getDate() - 30);
  $("from-date").value = formatDate(from);
  $("to-date").value = formatToday();

  // 通信を待つ前にイベントを登録する（待っている間の操作を取りこぼさないため）
  $("tab-work").addEventListener("click", () => switchTab("work"));
  $("tab-spray").addEventListener("click", () => switchTab("spray"));
  $("tab-growth").addEventListener("click", () => switchTab("growth"));
  $("tab-usage").addEventListener("click", () => switchTab("usage"));
  $("tab-bench").addEventListener("click", () => switchTab("bench"));
  $("search").addEventListener("click", load);
  $("from-date").addEventListener("change", load);
  $("to-date").addEventListener("change", load);
  $("base-filter").addEventListener("change", load);
  $("purpose-filter").addEventListener("input", render);

  onStoreChange = load; // 取り込みが済んだら描き直す
  load(); // 一覧の取得は拠点フィルタの描画を待たずに始める

  state.masters = await loadMasters(function (fresh) {
    state.masters = fresh;
    renderBaseFilter();
    if (state.tab === "bench") load();
  });
  renderBaseFilter();
  if (state.tab === "bench") load();
}

// マスタが更新されたときに呼び直されるので、毎回作り直す（選択中の拠点は保つ）
function renderBaseFilter() {
  const sel = $("base-filter");
  const current = sel.value;
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "すべて";
  sel.appendChild(all);
  activeBases(state.masters).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.value = current;
}

function switchTab(tab) {
  state.tab = tab;
  $("tab-work").classList.toggle("active", tab === "work");
  $("tab-spray").classList.toggle("active", tab === "spray");
  $("tab-growth").classList.toggle("active", tab === "growth");
  $("tab-usage").classList.toggle("active", tab === "usage");
  $("tab-bench").classList.toggle("active", tab === "bench");
  $("purpose-filter-box").hidden = tab !== "spray";
  // 使用回数は作の区切りで、列の経過は今日から何日かで見るので、期間の指定は使わない
  $("period-box").hidden = tab === "usage" || tab === "bench";
  // 列の経過は拠点ごとにしか描けないので、「すべて」のままなら先頭の拠点にしておく
  if (tab === "bench" && !$("base-filter").value && state.masters) {
    $("base-filter").value = activeBases(state.masters)[0] || "";
  }
  load();
}

// 取得した記録を保持しておき、目的での絞り込みは再取得せず手元で行う
let loaded = { records: [], weatherMap: {} };

// ストアは直近90日ぶんを持っている。その範囲ならサーバーに聞かずに描ける
function storeCovers(from) {
  const limit = new Date();
  limit.setDate(limit.getDate() - STORE_DAYS);
  return from >= formatDate(limit);
}

function fromStore(kind, params) {
  return storeRead(kind)
    .filter((r) => {
      const d = recordDate(kind, r);
      if (params.from && d < params.from) return false;
      if (params.to && d > params.to) return false;
      if (params.base && r.拠点 !== params.base) return false;
      return true;
    })
    .sort((a, b) => (recordDate(kind, a) < recordDate(kind, b) ? 1 : -1));
}

// 押した手応えが無いと待っていいのか分からないので、いまの状態を必ず出す
function setStatus(text) {
  $("search-status").textContent = text;
}

function countLabel(n) {
  return n === 0 ? "この条件の記録はありません" : n + "件";
}

let loadSeq = 0; // 続けて押されたとき、古い結果で上書きしないための通し番号

async function load() {
  const seq = ++loadSeq;
  const params = {
    from: $("from-date").value,
    to: $("to-date").value,
    base: $("base-filter").value,
  };
  if (state.tab === "usage") return loadUsage();
  if (state.tab === "bench") return renderBenchAges();
  const kind = state.tab === "work" ? "work" : state.tab === "growth" ? "growth" : "spray";

  // 記録も気象も手元にあるので、まずそれで描き切る（90日以内ならここで終わり）
  loaded = { records: fromStore(kind, params), weatherMap: weatherMap() };
  render();

  // 90日より前まで遡るときだけサーバーに取りに行く
  if (storeCovers(params.from)) return;

  setStatus(countLabel(loaded.records.length) + "（古い記録を取得中…）");
  const action = state.tab === "work" ? "records" : state.tab === "growth" ? "growths" : "sprays";
  const [recordsRes, weatherRes] = await Promise.all([
    apiGet(action, params),
    apiGet("weatherRange", { from: params.from, to: params.to }),
  ]);
  if (seq !== loadSeq) return; // 待っている間に条件が変わった

  if (weatherRes && weatherRes.ok) {
    (weatherRes.items || []).forEach((w) => { loaded.weatherMap[String(w.日付 || "").slice(0, 10)] = w; });
  }
  const failed = !(recordsRes && recordsRes.ok);
  if (!failed) loaded.records = recordsRes.records || [];
  render();
  setStatus(countLabel(loaded.records.length) + (failed ? "（古い記録は読み込めませんでした）" : ""));
}

function weatherLine(w) {
  if (!w) return "気象データなし";
  const kubun = w.取得区分 === "実績" ? "" : "（予報）";
  return `${w.天気概況}${kubun}　最高${w.最高気温}℃ / 最低${w.最低気温}℃`;
}

// 目的タグと目的自由入力の両方から探す
function matchesPurpose(r, keyword) {
  if (!keyword) return true;
  return [r.目的タグ, r.目的自由入力].filter(Boolean).join(" ").includes(keyword);
}

function itemsLabel(r) {
  return (r.items || [])
    .map((it) => `${it.資材名}（${it.希釈倍数 || ((it.使用量 || "") + (it.使用量単位 || ""))}）`)
    .join("・");
}

function purposeLabel(r) {
  return [r.目的タグ, r.目的自由入力].filter(Boolean).join("、");
}

function render() {
  const box = $("record-list");
  box.innerHTML = "";

  const keyword = $("purpose-filter").value.trim();
  const records = state.tab === "spray"
    ? loaded.records.filter((r) => matchesPurpose(r, keyword))
    : loaded.records;

  $("empty-hint").hidden = records.length > 0;
  setStatus(readStore().syncedAt ? countLabel(records.length) : "端末の記録 " + records.length + "件・共有データは未取得");
  let lastDate = null;
  records.forEach((r) => {
    const date = state.tab === "work" ? r.作業日 : state.tab === "growth" ? r.調査日 : r.使用年月日;
    if (date !== lastDate) {
      lastDate = date;
      const wRow = el("div", "weather-row");
      wRow.appendChild(el("span", "weather-date", date));
      wRow.appendChild(el("span", "", weatherLine(loaded.weatherMap[date])));
      box.appendChild(wRow);
    }

    const row = el("div", "item history-item" + (r.状態 === "取消" ? " cancelled" : ""));
    if (state.tab === "work") {
      const label = `${r.拠点}/${r["棟・区画"]} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`;
      row.appendChild(el("span", "grow", label));
      if (r.数量) row.appendChild(el("span", "sub", `${r.数量}${r.数量単位 || ""}`));
    } else if (state.tab === "growth") {
      const items = r.items || [];
      const stems = items.map((it) => parseFloat(it.茎径mm)).filter((v) => !isNaN(v));
      const dists = items.map((it) => parseFloat(it.生長点花房距離cm)).filter((v) => !isNaN(v));
      const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
      const parts = [];
      if (avg(stems) !== null) parts.push("茎径 平均" + avg(stems) + "mm");
      if (avg(dists) !== null) parts.push("花房距離 平均" + avg(dists) + "cm");
      row.appendChild(el("span", "grow", `${r.拠点}/${r["棟・区画"]} / ${items.length}株`));
      if (parts.length) row.appendChild(el("span", "sub", parts.join("・")));
    } else {
      const kubun = r.散布区分 ? `[${r.散布区分}] ` : "";
      row.appendChild(el("span", "grow", `${kubun}${r.拠点}/${r["棟・区画"]} / ${itemsLabel(r)}`));
      const p = purposeLabel(r);
      if (p) row.appendChild(el("span", "sub", p));
    }
    if (r.状態 === "取消") row.appendChild(el("span", "cancelled-label", "取消済"));
    box.appendChild(row);
  });
}

// ---------- 使用回数タブ ----------
// 「この作であと何回使えるか」を棟ごとに並べる。期間ではなく、マスタ_拠点棟の
// 「現作の開始日」で区切る。制限は本剤・成分の通算の2本立てで、成分のほうは
// 製品が違っても足し算されるので、剤ごとに見ているだけでは超過に気づけない。

async function loadUsage() {
  const base = $("base-filter").value;
  const list = $("record-list");
  $("empty-hint").hidden = true;
  if (!base) {
    list.innerHTML = "";
    list.appendChild(el("p", "hint", "拠点を選ぶと、棟ごとの使用回数が出ます"));
    setStatus("");
    return;
  }
  setStatus("読み込み中…");
  const seq = loadSeq;
  const records = await loadSprayHistory(base, (fresh) => {
    if (seq !== loadSeq) return;
    renderUsage(base, fresh);
  });
  if (seq !== loadSeq) return;
  renderUsage(base, records);
  setStatus("");
}

function renderUsage(base, records) {
  const list = $("record-list");
  list.innerHTML = "";
  const cached = readSprayHistoryCache(base);
  list.appendChild(el("p", "hint", cached
    ? "履歴取得: " + formatDate(new Date(cached.savedAt)) + " " + timeLabel(new Date(cached.savedAt).toTimeString()) + "（他の端末の未同期記録は含みません）"
    : "散布履歴は未取得です。使用回数はまだ確認できません"));
  if (!cached) return;
  const buildings = buildingsOfBase(state.masters, base);
  const names = buildings.length ? buildings.map((b) => b.棟区画名) : [""];

  names.forEach((name) => {
    const u = countSprayUsage(records, state.masters, base, name);
    const card = el("div", "record");
    card.appendChild(el("div", "record-head", (name || base)
      + (u.since ? "（作の開始 " + u.since + " から）" : "（全期間）")));

    const rows = [];
    // 本剤の回数。上限が分かっているものを先に、残りの少ない順に並べる
    Object.keys(u.materials).sort().forEach((matName) => {
      const m = (state.masters.materials || []).find((x) => x.薬剤名 === matName);
      const st = usageStatusOf(m, u);
      const used = u.materials[matName];
      if (!st) { rows.push([matName, used + "回", false]); return; }
      rows.push([matName, st.limit ? used + "/" + st.limit + "回" : used + "回", st.full]);
    });
    card.appendChild(usageGroup("資材ごと", rows, "この作ではまだ撒いていません"));

    const ing = Object.keys(u.ingredients).sort().map((gname) => {
      // 上限は、その成分を持つ資材のどれかから引く（同じ成分なら同じ上限）
      let limit = null;
      (state.masters.materials || []).forEach((m) => {
        parseIngredientLimits(m["成分と通算回数"]).forEach((g) => {
          if (g.name === gname && g.limit) limit = g.limit;
        });
      });
      const n = u.ingredients[gname];
      return [gname, limit ? n + "/" + limit + "回" : n + "回", !!(limit && n >= limit)];
    });
    card.appendChild(usageGroup("成分の通算（製品が違っても足される）", ing, "なし"));

    const codes = []
      .concat(Object.keys(u.irac).sort().map((c) => ["IRAC " + c, u.irac[c] + "回", false]))
      .concat(Object.keys(u.frac).sort().map((c) => ["FRAC " + c, u.frac[c] + "回", false]));
    card.appendChild(usageGroup("作用機構（同じコードが続くと効かなくなる）", codes, "なし"));

    list.appendChild(card);
  });
}

function usageGroup(title, rows, emptyText) {
  const box = el("div", "usage-group");
  box.appendChild(el("div", "usage-title", title));
  if (rows.length === 0) {
    box.appendChild(el("div", "hint", emptyText));
    return box;
  }
  rows.forEach(([label, value, full]) => {
    const row = el("div", "usage-row");
    row.appendChild(el("span", "grow", label));
    row.appendChild(el("span", "use-badge" + (full ? " is-full" : ""), value));
    box.appendChild(row);
  });
  return box;
}

// ---------- 列の経過タブ ----------
// 棟を1つ選び、列（ベンチの片側）ごとに全作業の「最後にやってから何日か」を表で並べる。
// 作業画面の列マップは作業を1つ選んで色を見る形にしたので、全作業をまとめて見るのはここ（2026-10-07 ユーザー）。
// 数え方は作業画面と同じ lastDoneByCell（列を選んだ作業記録＋散布記録は棟全体、手元にある直近90日）

// 列幅に収まらない作業名は、語の切れ目で2行にする（任せると「つる下ろ／し」と切れるため）
const HEAD_BREAK = { つる下ろし: "つる\n下ろし", トーン処理: "トーン\n処理", 葉面散布: "葉面\n散布" };

function ageCell(tag, work, date) {
  if (!date) return el(tag, "ages-cell none", "−");
  const a = ageStep(date);
  const cell = el(tag, "ages-cell age" + a.step, a.text);
  cell.title = work + "：" + date;
  return cell;
}

function renderBenchAges() {
  const list = $("record-list");
  list.innerHTML = "";
  $("empty-hint").hidden = true;
  setStatus("");
  const base = $("base-filter").value;
  if (!state.masters) {
    list.appendChild(el("p", "hint", "読み込み中…"));
    return;
  }
  if (!base) {
    list.appendChild(el("p", "hint", "拠点を選ぶと、棟ごとの経過が出ます"));
    return;
  }
  const buildings = buildingsOfBase(state.masters, base).map((b) => b.棟区画名).filter((n) => benchLayoutOf(base, n));
  if (buildings.length === 0) {
    list.appendChild(el("p", "hint", "この拠点は列の並びが未登録です"));
    return;
  }
  if (!buildings.includes(state.benchBuilding)) state.benchBuilding = buildings[0];
  const b = state.benchBuilding;

  if (buildings.length > 1) {
    const row = el("div", "btn-row ages-buildings");
    buildings.forEach((name) => {
      const btn = el("button", "btn" + (name === b ? " active" : ""), name);
      btn.type = "button";
      btn.addEventListener("click", () => {
        state.benchBuilding = name;
        renderBenchAges();
      });
      row.appendChild(btn);
    });
    list.appendChild(row);
  }

  const L = benchLayoutOf(base, b);
  const last = lastDoneByCell(base);
  // 表の横に並べる作業。この棟で一度でも記録のあるものだけを、マスタの表示順→散布の順に出す
  const prefix = b + "-";
  const done = new Set();
  last.forEach((_, key) => { if (key.startsWith(prefix)) done.add(key.slice(key.indexOf("|") + 1)); });
  const order = (state.masters.workTypes || [])
    .filter((w) => String(w.有効フラグ).toUpperCase() === "TRUE")
    .sort((x, y) => Number(x.表示順) - Number(y.表示順))
    .map((w) => w.作業名);
  const works = order.filter((w) => done.has(w) && !SPRAY_WORKS.includes(w))
    .concat([...done].filter((w) => !order.includes(w) && !SPRAY_WORKS.includes(w)))
    .concat(SPRAY_WORKS.filter((w) => done.has(w)));
  if (works.length === 0) {
    list.appendChild(el("p", "hint", "この棟には、列を選んで記録した作業がまだありません"));
    return;
  }

  const table = el("table", "ages-table");
  const head = el("tr");
  head.appendChild(el("th", "ages-rowhead", "列"));
  works.forEach((w) => head.appendChild(el("th", "", HEAD_BREAK[w] || w)));
  const thead = el("thead");
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (let col = 1; col <= L.cols; col++) {
    // 前の列との間が通路なら隙間を空け、中央通路は線にする（入口から見た並びと同じ区切り）
    if (col > 1 && (L.centerAfter === col - 1 || (L.aisleAfter || []).includes(col - 1))) {
      const gap = el("tr", "ages-gap" + (L.centerAfter === col - 1 ? " center" : ""));
      const td = el("td");
      td.colSpan = works.length + 1;
      gap.appendChild(td);
      tbody.appendChild(gap);
    }
    // 手前／奥に分かれる列も1行にし、マスの中を上＝奥・下＝手前の2段に割る（列マップと同じ向き）。
    // 「9 奥」「9 手前」を別の行にすると、列の区切りが見えず読みにくかった（2026-10-07 ユーザー）
    const split = positionsOf(L, col).length > 1;
    const tr = el("tr", split ? "ages-split-row" : "");
    const th = el("th", "ages-rowhead");
    th.appendChild(el("span", "ages-colno", String(col)));
    if (split) {
      const pos = el("span", "ages-pos");
      pos.appendChild(el("span", "", "奥"));
      pos.appendChild(el("span", "", "手前"));
      th.appendChild(pos);
    }
    tr.appendChild(th);
    works.forEach((w) => {
      if (!split) {
        tr.appendChild(ageCell("td", w, last.get(cellToken(b, col, "") + "|" + w)));
        return;
      }
      const td = el("td", "ages-split");
      ["奥", "手前"].forEach((pos) => td.appendChild(ageCell("div", w, last.get(cellToken(b, col, pos) + "|" + w))));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const scroll = el("div", "ages-scroll");
  scroll.appendChild(table);
  list.appendChild(scroll);

  const legend = el("div", "age-legend");
  legend.appendChild(el("span", "", "今日"));
  for (let i = 0; i <= 7; i++) legend.appendChild(el("span", "age-chip age" + i));
  legend.appendChild(el("span", "", "7日以上"));
  list.appendChild(legend);
  list.appendChild(el("p", "hint", "数字は最後にやってからの日数。列を選んで記録した作業だけを数えます（直近90日）"));
}
