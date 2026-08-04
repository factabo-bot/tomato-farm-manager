"use strict";

const profile = getProfile();

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = profile.displayName + (isMock ? "（お試しモード）" : "");
  $("display-name-input").value = profile.displayName;

  $("save-name").addEventListener("click", () => {
    const name = $("display-name-input").value.trim();
    if (!name) return toast("名前を入力してください");
    setDisplayName(name);
    toast("保存しました");
    $("user-info").textContent = name + (isMock ? "（お試しモード）" : "");
  });

  const res = await apiGet("mytoday", { userId: profile.userId });
  const work = res.work || [];
  const spray = res.spray || res.pesticide || [];
  const growth = res.growth || [];
  $("work-count").textContent = work.length;
  $("spray-count").textContent = spray.length;
  $("growth-count").textContent = growth.length;
  renderTodayList(work, spray, growth);
}

function renderTodayList(work, spray, growth) {
  const box = $("today-list");
  box.innerHTML = "";
  const items = [];

  work.forEach((r) => items.push({
    time: (r.記録日時 || "").slice(11, 16),
    label: `📝 ${r["棟・区画"]} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`,
  }));

  // 散布記録は資材名を並べて表示する（散布区分＝防除／葉面散布も添える）
  spray.forEach((r) => {
    const names = (r.items || []).map((it) => it.資材名).filter(Boolean).join("・");
    const kubun = r.散布区分 ? `[${r.散布区分}] ` : "";
    items.push({
      time: (r.開始時刻 || (r.更新日時 || "").slice(11, 16)),
      label: `🧪 ${kubun}${r["棟・区画"]} / ${names || "（資材未登録）"}`,
    });
  });

  (growth || []).forEach((r) => {
    const n = (r.items || []).length;
    items.push({
      time: (r.更新日時 || "").slice(11, 16),
      label: `📏 ${r["棟・区画"]} / 生育調査 ${n}株`,
    });
  });

  if (items.length === 0) {
    box.appendChild(el("div", "hint", "今日はまだ記録がありません"));
    return;
  }
  items.sort((a, b) => (a.time < b.time ? 1 : -1));
  items.forEach((it) => {
    const row = el("div", "item");
    row.appendChild(el("span", "", `${it.time} ${it.label}`));
    box.appendChild(row);
  });
}
