"use strict";

const state = {
  masters: null,
  base: null,
  building: null,
  workType: null,
  profile: getProfile(),
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  $("work-date").value = formatToday();

  state.masters = await apiGet("masters");

  renderBases();
  renderWorkTypes();
  await loadMyRecords();

  $("submit").addEventListener("click", submit);
}

function renderBases() {
  const box = $("base-buttons");
  box.innerHTML = "";
  const bases = activeBases(state.masters);
  if (!state.base) state.base = bases[0];
  bases.forEach((name) => {
    const btn = el("button", "btn" + (name === state.base ? " active" : ""), name);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.base = name;
      state.building = null;
      renderBases();
    });
    box.appendChild(btn);
  });
  renderBuildings();
}

function renderBuildings() {
  const box = $("building-buttons");
  box.innerHTML = "";
  const buildings = buildingsOfBase(state.masters, state.base);
  if (!state.building && buildings.length > 0) state.building = buildings[0].棟区画名;
  buildings.forEach((b) => {
    const btn = el("button", "btn" + (b.棟区画名 === state.building ? " active" : ""), b.棟区画名);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.building = b.棟区画名;
      renderBuildings();
    });
    box.appendChild(btn);
  });
}

function activeWorkTypes() {
  return (state.masters.workTypes || [])
    .filter((w) => String(w.有効フラグ).toUpperCase() === "TRUE")
    .sort((a, b) => Number(a.表示順) - Number(b.表示順));
}

function renderWorkTypes() {
  const box = $("work-buttons");
  box.innerHTML = "";
  activeWorkTypes().forEach((w) => {
    const btn = el("button", "btn" + (w.作業名 === state.workType ? " active" : ""), w.作業名);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.workType = w.作業名;
      renderWorkTypes();
      $("work-detail").hidden = w.作業名 !== "その他";
    });
    box.appendChild(btn);
  });
}

async function submit() {
  if (!state.base) return toast("拠点を選択してください");
  if (!state.building) return toast("棟・区画を選択してください");
  if (!state.workType) return toast("作業を選択してください");
  if (state.workType === "その他" && !$("work-detail").value.trim()) {
    return toast("作業内容を記入してください");
  }

  const payload = {
    workDate: $("work-date").value || formatToday(),
    base: state.base,
    building: state.building,
    workType: state.workType,
    workDetail: $("work-detail").value.trim(),
    startTime: $("start-time").value,
    endTime: $("end-time").value,
    durationMin: computeDuration(),
    quantity: $("quantity").value,
    quantityUnit: $("quantity-unit").value.trim(),
    weather: $("weather").value,
    temperature: $("temperature").value,
    recorder: state.profile.displayName,
    userId: state.profile.userId,
    note: $("note").value.trim(),
  };

  $("submit").disabled = true;
  try {
    const res = await apiPostWithQueue(payload);
    if (!res.ok) {
      toast("⚠ " + (res.error || "記録に失敗しました"));
      return;
    }
    toast(res.queued ? "📤 電波が弱いので保留しました（オンライン復帰時に自動送信）" : "✅ 記録しました");
    resetForm();
    await loadMyRecords();
  } catch (err) {
    console.error(err);
    toast("⚠ 送信に失敗しました");
  } finally {
    $("submit").disabled = false;
  }
}

function computeDuration() {
  const s = $("start-time").value;
  const e = $("end-time").value;
  if (!s || !e) return "";
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : "";
}

function resetForm() {
  state.workType = null;
  $("work-detail").value = "";
  $("work-detail").hidden = true;
  $("start-time").value = "";
  $("end-time").value = "";
  $("quantity").value = "";
  $("quantity-unit").value = "";
  $("weather").value = "";
  $("temperature").value = "";
  $("note").value = "";
  renderWorkTypes();
}

async function loadMyRecords() {
  const res = await apiGet("mytoday", { userId: state.profile.userId });
  renderMyRecords(res.work || []);
}

function renderMyRecords(records) {
  const box = $("my-records");
  box.innerHTML = "";
  if (records.length === 0) {
    box.appendChild(el("div", "hint", "今日の記録はまだありません"));
    return;
  }
  records.slice().reverse().forEach((r) => {
    const row = el("div", "item");
    const time = (r.記録日時 || "").slice(11, 16);
    const label = `${time} ${r["棟・区画"]} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`;
    row.appendChild(el("span", "", label));
    const del = el("button", "del", "取消");
    del.type = "button";
    del.addEventListener("click", () => {
      if (del.dataset.arm !== "1") {
        del.dataset.arm = "1";
        del.textContent = "本当に取消？";
        setTimeout(() => {
          del.dataset.arm = "";
          del.textContent = "取消";
        }, 3000);
        return;
      }
      cancelRecord(r.記録ID);
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function cancelRecord(id) {
  const res = await apiPost({ type: "cancelRecord", id, userId: state.profile.userId });
  if (!res.ok) {
    toast("⚠ " + (res.error || "取消に失敗しました"));
    return;
  }
  toast("取り消しました");
  await loadMyRecords();
}
