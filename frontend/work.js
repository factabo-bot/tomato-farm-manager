"use strict";

const state = {
  masters: null,
  base: null,
  buildings: new Set(), // 収穫などで複数の棟をまとめて回ることがあるので複数選択
  workType: null,
  profile: getProfile(),
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  $("work-date").value = formatToday();

  // 通信を待つ前にイベントを登録する（待っている間のタップを取りこぼさないため）
  $("submit").addEventListener("click", submit);

  // キャッシュがあれば即座に描画し、最新版が届いて中身が変わっていたら描き直す
  state.masters = await loadMasters(function (fresh) {
    state.masters = fresh;
    renderBases();
    renderWorkTypes();
  });

  renderBases();
  renderWorkTypes();

  loadMyRecords(); // 今日の記録は入力を妨げないよう待たずに読む
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
      state.buildings.clear(); // 拠点が変われば棟の選択も外す
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

  // 未選択のときは先頭の棟を既定にしておく（1棟だけの拠点でいちいち選ばなくて済むように）
  if (state.buildings.size === 0 && buildings.length > 0) {
    state.buildings.add(buildings[0].棟区画名);
  }

  buildings.forEach((b) => {
    const name = b.棟区画名;
    const btn = el("button", "btn" + (state.buildings.has(name) ? " active" : ""), name);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.buildings.has(name) ? state.buildings.delete(name) : state.buildings.add(name);
      renderBuildings();
    });
    box.appendChild(btn);
  });

  // 棟が複数ある拠点だけ一括選択を出す（1棟しかない拠点では邪魔になるため）
  const bulk = $("building-bulk");
  bulk.innerHTML = "";
  if (buildings.length > 1) {
    const all = el("button", "btn chip", "すべて選択");
    all.type = "button";
    all.addEventListener("click", () => {
      buildings.forEach((b) => state.buildings.add(b.棟区画名));
      renderBuildings();
    });
    bulk.appendChild(all);

    const clear = el("button", "btn chip", "選択を解除");
    clear.type = "button";
    clear.addEventListener("click", () => {
      state.buildings.clear();
      renderBuildings();
    });
    bulk.appendChild(clear);
  }
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
  if (state.buildings.size === 0) return toast("棟・区画を選択してください");
  if (!state.workType) return toast("作業を選択してください");
  if (state.workType === "その他" && !$("work-detail").value.trim()) {
    return toast("作業内容を記入してください");
  }

  const payload = {
    workDate: $("work-date").value || formatToday(),
    base: state.base,
    // 複数の棟をまとめて回った場合は「1号棟、2号棟」のように1つの記録にまとめる
    building: [...state.buildings].join(PURPOSE_SEPARATOR),
    workType: state.workType,
    workDetail: $("work-detail").value.trim(),
    startTime: $("start-time").value,
    endTime: $("end-time").value,
    durationMin: computeDuration(),
    quantity: $("quantity").value,
    quantityUnit: $("quantity-unit").value.trim(),
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
