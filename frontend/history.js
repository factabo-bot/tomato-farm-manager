"use strict";

const state = {
  masters: null,
  tab: "work",
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
  $("from-date").addEventListener("change", load);
  $("to-date").addEventListener("change", load);
  $("base-filter").addEventListener("change", load);
  $("purpose-filter").addEventListener("input", render);

  onStoreChange = load; // 取り込みが済んだら描き直す
  load(); // 一覧の取得は拠点フィルタの描画を待たずに始める

  state.masters = await loadMasters(function (fresh) {
    state.masters = fresh;
    renderBaseFilter();
  });
  renderBaseFilter();
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
  $("purpose-filter-box").hidden = tab !== "spray";
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

async function load() {
  const params = {
    from: $("from-date").value,
    to: $("to-date").value,
    base: $("base-filter").value,
  };
  const kind = state.tab === "work" ? "work" : state.tab === "growth" ? "growth" : "spray";

  // まず手元のぶんで描く（待たせない）
  loaded = { records: fromStore(kind, params), weatherMap: loaded.weatherMap };
  render();

  // 90日より前まで遡るときだけサーバーに取りに行く
  const jobs = [apiGet("weatherRange", { from: params.from, to: params.to })];
  const needServer = !storeCovers(params.from);
  if (needServer) {
    const action = state.tab === "work" ? "records" : state.tab === "growth" ? "growths" : "sprays";
    jobs.push(apiGet(action, params));
  }
  const [weatherRes, recordsRes] = await Promise.all(jobs);

  const weatherMap = {};
  ((weatherRes && weatherRes.items) || []).forEach((w) => { weatherMap[w.日付] = w; });
  loaded = {
    records: needServer && recordsRes && recordsRes.ok ? recordsRes.records || [] : loaded.records,
    weatherMap,
  };
  render();
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
