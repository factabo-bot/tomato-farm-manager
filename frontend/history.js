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

  state.masters = await apiGet("masters");
  renderBaseFilter();

  $("tab-work").addEventListener("click", () => switchTab("work"));
  $("tab-pesticide").addEventListener("click", () => switchTab("pesticide"));
  $("from-date").addEventListener("change", load);
  $("to-date").addEventListener("change", load);
  $("base-filter").addEventListener("change", load);

  await load();
}

function renderBaseFilter() {
  const sel = $("base-filter");
  activeBases(state.masters).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
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
  const res = await apiGet(action, params);
  render(res.records || []);
}

function render(records) {
  const box = $("record-list");
  box.innerHTML = "";
  $("empty-hint").hidden = records.length > 0;
  records.forEach((r) => {
    const row = el("div", "item history-item" + (r.状態 === "取消" ? " cancelled" : ""));
    if (state.tab === "work") {
      const label = `${r.作業日} ${r.拠点}/${r["棟・区画"]} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`;
      row.appendChild(el("span", "", label));
      if (r.数量) row.appendChild(el("span", "sub", `${r.数量}${r.数量単位 || ""}`));
    } else {
      const dose = r.希釈倍数 || (r.使用量 ? r.使用量 + r.使用量単位 : "");
      const label = `${r.使用年月日} ${r.拠点}/${r["棟・区画"]} / ${r["農薬の種類・名称"]}（${dose}）`;
      row.appendChild(el("span", "", label));
      if (r.対象病害虫) row.appendChild(el("span", "sub", r.対象病害虫));
    }
    if (r.状態 === "取消") row.appendChild(el("span", "cancelled-label", "取消済"));
    box.appendChild(row);
  });
}
