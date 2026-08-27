"use strict";

const state = {
  masters: null,
  base: null,
  buildings: new Set(), // 収穫などで複数の棟をまとめて回ることがあるので複数選択
  workType: null,
  profile: getProfile(),
  sprayByDate: {},  // 日付 → その日の散布記録。同じ日を何度も問い合わせないためのキャッシュ
  sprayLoading: {}, // 日付 → 取得中の約束。押し直しで問い合わせが二重に走らないようにする
  checking: null,   // 確認中の散布区分（"防除" / "葉面散布"）。未確認のときは null
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  $("work-date").value = formatToday();

  // 通信を待つ前にイベントを登録する（待っている間のタップを取りこぼさないため）
  $("submit").addEventListener("click", submit);
  $("check-pest").addEventListener("click", () => checkSpray("防除"));
  $("check-foliar").addEventListener("click", () => checkSpray("葉面散布"));
  $("work-date").addEventListener("change", clearSprayStatus);

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

  // 場所を選び直したら、表示中の散布記録の確認結果も新しい場所で出し直す
  refreshSprayStatus();
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

// ---------- 防除・葉面散布の確認（散布記録は散布画面が持つので、ここでは有無だけ見る） ----------

function clearSprayStatus() {
  state.checking = null;
  const box = $("spray-status");
  box.hidden = true;
  box.innerHTML = "";
}

async function checkSpray(kubun) {
  if (!state.base) return toast("拠点を選択してください");
  state.checking = kubun;
  const date = $("work-date").value || formatToday();

  const box = $("spray-status");
  box.hidden = false;
  box.className = "spray-status checking";
  box.textContent = "確認中…";

  let list;
  try {
    list = await loadSprays(date);
  } catch (err) {
    console.error(err);
    if (state.checking !== kubun) return;
    box.className = "spray-status missing";
    box.textContent = "⚠ 散布記録を確認できませんでした（電波が届いていないかもしれません）";
    return;
  }
  if (state.checking !== kubun) return; // 待っている間に別のボタンが押された
  renderSprayStatus(list, kubun, date);
}

// GASの応答は5秒前後かかるので、一度読んだ日はキャッシュから返す。
// 読んでいる途中に押し直されても問い合わせが二重に走らないよう、実行中の約束も持っておく
async function loadSprays(date) {
  if (state.sprayByDate[date]) return state.sprayByDate[date];
  if (!state.sprayLoading[date]) {
    state.sprayLoading[date] = apiGet("sprays", { from: date, to: date })
      .then((res) => {
        const list = (res.records || []).filter((r) => r.状態 !== "取消");
        state.sprayByDate[date] = list;
        return list;
      })
      .finally(() => { delete state.sprayLoading[date]; });
  }
  return state.sprayLoading[date];
}

// 散布区分は「防除・葉面散布」のように2つ入ることがあるので部分一致で見る
function matchesKubun(r, kubun) {
  return String(r.散布区分 || "").indexOf(kubun) >= 0;
}

// 散布記録の棟は「1号棟、2号棟」とまとめて入るので、選択中の棟と1つでも重なれば同じ場所とみなす
function matchesPlace(r) {
  if (r.拠点 !== state.base) return false;
  if (state.buildings.size === 0) return true;
  const recorded = String(r["棟・区画"] || "")
    .split(PURPOSE_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  if (recorded.length === 0) return true;
  return recorded.some((b) => state.buildings.has(b));
}

function placeLabel() {
  const rooms = [...state.buildings].join(PURPOSE_SEPARATOR);
  return state.base + (rooms ? "／" + rooms : "");
}

// 日付・拠点・棟を引き継いで散布画面へ渡す（向こうで選び直さなくて済むように）
function sprayLink(label, date, kubun) {
  const qs = new URLSearchParams({
    date: date,
    base: state.base || "",
    buildings: [...state.buildings].join(PURPOSE_SEPARATOR),
    kubun: kubun,
  });
  const a = el("a", "btn-secondary", label);
  a.href = "pesticide.html?" + qs.toString();
  return a;
}

// 確認済みの表示を、いまの日付・場所で出し直す（通信はせずキャッシュだけ見る）
function refreshSprayStatus() {
  if (!state.checking) return;
  const date = $("work-date").value || formatToday();
  const list = state.sprayByDate[date];
  if (!list) return;
  renderSprayStatus(list, state.checking, date);
}

function renderSprayStatus(list, kubun, date) {
  const box = $("spray-status");
  const hits = list.filter((r) => matchesKubun(r, kubun) && matchesPlace(r));
  const when = date === formatToday() ? "今日" : date;
  box.innerHTML = "";
  box.hidden = false;

  if (hits.length === 0) {
    box.className = "spray-status missing";
    box.appendChild(el("div", "spray-status-head", `⚠ ${when}の${placeLabel()}に${kubun}の散布記録はまだありません`));
    box.appendChild(sprayLink("🧪 散布画面で入力する", date, kubun));
    return;
  }

  box.className = "spray-status found";
  box.appendChild(el("div", "spray-status-head", `✅ ${when}の${kubun}は散布記録に登録済みです`));
  hits.forEach((r) => {
    const names = (r.items || []).map((it) => it.資材名).filter(Boolean).join("・");
    const time = timeLabel(r.開始時刻);
    box.appendChild(el("div", "spray-status-row", `${time ? time + " " : ""}${r["棟・区画"]} / ${names || "（資材未登録）"}`));
  });
  box.appendChild(sprayLink("🧪 散布画面で追加・修正する", date, kubun));
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
    await loadMyRecords(true);
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

// 記録した直後・取り消した直後は force で取り直す。
// それ以外はキャッシュを即座に描いて、裏で届いた最新に差し替える
async function loadMyRecords(force) {
  const show = (r) => renderMyRecords(r.work || [], r.spray || r.pesticide || []);
  if (force) {
    const fresh = await reloadToday(state.profile.userId);
    if (fresh && fresh.ok) show(fresh);
    return;
  }
  show(await loadToday(state.profile.userId, show));
}

// 作業画面だけ見てもその日にやったことが揃うよう、散布記録も一緒に並べる。
// 並んでいる以上ここで取り消せないと不便なので、散布記録も取消できるようにしている
function renderMyRecords(work, sprays) {
  const box = $("my-records");
  box.innerHTML = "";
  if (work.length === 0 && sprays.length === 0) {
    box.appendChild(el("div", "hint", "今日の記録はまだありません"));
    return;
  }

  const rows = work.map((r) => ({
    time: timeLabel(r.記録日時),
    label: `📝 ${r["棟・区画"]} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`,
    id: r.記録ID,
    kind: "work",
  }));

  sprays.forEach((r) => {
    const names = (r.items || []).map((it) => it.資材名).filter(Boolean).join("・");
    const kubun = r.散布区分 ? `[${r.散布区分}] ` : "";
    rows.push({
      time: timeLabel(r.開始時刻) || timeLabel(r.更新日時),
      label: `🧪 ${kubun}${r["棟・区画"]} / ${names || "（資材未登録）"}`,
      id: r.記録ID,
      kind: "spray",
    });
  });

  rows.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

  rows.forEach((r) => {
    const row = el("div", "item");
    row.appendChild(el("span", "grow", `${r.time} ${r.label}`));
    if (!r.id) {
      box.appendChild(row);
      return;
    }
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
      r.kind === "spray" ? cancelSprayRecord(r.id) : cancelRecord(r.id);
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
  await loadMyRecords(true);
}

// 散布記録の取消。確認欄に出している内容も古くなるので、キャッシュを捨てて取り直す
async function cancelSprayRecord(id) {
  const res = await apiPost({ type: "cancelSpray", id, userId: state.profile.userId });
  if (!res.ok) {
    toast("⚠ " + (res.error || "取消に失敗しました"));
    return;
  }
  toast("散布記録を取り消しました");
  state.sprayByDate = {};
  state.sprayLoading = {};
  await loadMyRecords(true);
  if (state.checking) checkSpray(state.checking);
}
