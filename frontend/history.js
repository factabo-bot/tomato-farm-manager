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
  $("tab-pesticide").addEventListener("click", () => switchTab("pesticide"));
  $("from-date").addEventListener("change", load);
  $("to-date").addEventListener("change", load);
  $("base-filter").addEventListener("change", load);

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
  $("tab-pesticide").classList.toggle("active", tab === "pesticide");
  load();
}

async function load() {
  const params = {
    from: $("from-date").value,
    to: $("to-date").value,
    base: $("base-filter").value,
  };
  const action = state.tab === "work" ? "records" : "pesticides";
  const [recordsRes, weatherRes] = await Promise.all([
    apiGet(action, params),
    apiGet("weatherRange", { from: params.from, to: params.to }),
  ]);
  const weatherMap = {};
  (weatherRes.items || []).forEach((w) => { weatherMap[w.日付] = w; });
  render(recordsRes.records || [], weatherMap);
}

function weatherLine(w) {
  if (!w) return "気象データなし";
  const kubun = w.取得区分 === "実績" ? "" : "（予報）";
  return `${w.天気概況}${kubun}　最高${w.最高気温}℃ / 最低${w.最低気温}℃`;
}

function render(records, weatherMap) {
  const box = $("record-list");
  box.innerHTML = "";
  $("empty-hint").hidden = records.length > 0;
  let lastDate = null;
  records.forEach((r) => {
    const date = state.tab === "work" ? r.作業日 : r.使用年月日;
    if (date !== lastDate) {
      lastDate = date;
      const wRow = el("div", "weather-row");
      wRow.appendChild(el("span", "weather-date", date));
      wRow.appendChild(el("span", "", weatherLine(weatherMap[date])));
      box.appendChild(wRow);
    }

    const row = el("div", "item history-item" + (r.状態 === "取消" ? " cancelled" : ""));
    if (state.tab === "work") {
      const label = `${r.拠点}/${r["棟・区画"]} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`;
      row.appendChild(el("span", "", label));
      if (r.数量) row.appendChild(el("span", "sub", `${r.数量}${r.数量単位 || ""}`));
    } else {
      const names = (r.items || [])
        .map((it) => `${it.薬剤名}（${it.希釈倍数 || (it.使用量 + it.使用量単位)}）`)
        .join("・");
      const label = `${r.拠点}/${r["棟・区画"]} / ${names}`;
      row.appendChild(el("span", "", label));
      if (r.対象病害虫) row.appendChild(el("span", "sub", r.対象病害虫));
    }
    if (r.状態 === "取消") row.appendChild(el("span", "cancelled-label", "取消済"));
    box.appendChild(row);
  });
}
