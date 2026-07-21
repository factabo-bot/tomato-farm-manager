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
  const pesticide = res.pesticide || [];
  $("work-count").textContent = work.length;
  $("pesticide-count").textContent = pesticide.length;
  renderTodayList(work, pesticide);
}

function renderTodayList(work, pesticide) {
  const box = $("today-list");
  box.innerHTML = "";
  const items = [];
  work.forEach((r) => items.push({
    time: (r.記録日時 || "").slice(11, 16),
    label: `📝 ${r["棟・区画"]} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`,
  }));
  pesticide.forEach((r) => items.push({
    time: (r.記録日時 || r.更新日時 || "").slice(11, 16),
    label: `🧪 ${r["棟・区画"]} / ${r["農薬の種類・名称"]}`,
  }));
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
