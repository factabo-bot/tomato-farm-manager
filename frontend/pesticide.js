"use strict";

const state = {
  masters: null,
  base: null,
  building: null,
  profile: getProfile(),
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  $("use-date").value = formatToday();
  $("worker-name").placeholder = "未入力なら " + state.profile.displayName;

  state.masters = await apiGet("masters");

  renderBases();
  renderCrops();
  renderPesticideOptions();
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

function renderCrops() {
  const sel = $("crop-select");
  sel.innerHTML = "";
  (state.masters.crops || []).forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.品目名;
    opt.textContent = c.品目名;
    sel.appendChild(opt);
  });
}

function renderPesticideOptions() {
  const list = $("pesticide-list");
  list.innerHTML = "";
  (state.masters.pesticides || [])
    .filter((p) => String(p.有効フラグ).toUpperCase() === "TRUE")
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.薬剤名;
      list.appendChild(opt);
    });
}

function clientValidate(payload) {
  const missing = [];
  if (!payload.useDate) missing.push("使用年月日");
  if (!payload.base) missing.push("使用場所（拠点）");
  if (!payload.crop) missing.push("農作物の種類");
  if (!payload.pesticideName) missing.push("農薬の種類・名称");
  const hasDilution = !!payload.dilution;
  const hasAmount = !!(payload.amount && payload.amountUnit);
  if (!hasDilution && !hasAmount) missing.push("希釈倍数または使用量のいずれか");
  return missing;
}

async function submit() {
  const payload = {
    type: "pesticide",
    useDate: $("use-date").value,
    base: state.base,
    building: state.building,
    crop: $("crop-select").value,
    pesticideName: $("pesticide-name").value.trim(),
    dilution: $("dilution").value.trim(),
    amount: $("amount").value,
    amountUnit: $("amount-unit").value.trim(),
    totalVolumeL: $("total-volume").value,
    targetPest: $("target-pest").value.trim(),
    weather: $("weather").value,
    temperature: $("temperature").value,
    workerName: $("worker-name").value.trim() || state.profile.displayName,
    ppe: $("ppe").value.trim(),
    recorder: state.profile.displayName,
    userId: state.profile.userId,
    note: $("note").value.trim(),
  };

  const missing = clientValidate(payload);
  if (missing.length > 0) {
    toast("⚠ 必須項目が未入力です: " + missing.join("、"));
    return;
  }

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

function resetForm() {
  $("pesticide-name").value = "";
  $("dilution").value = "";
  $("amount").value = "";
  $("amount-unit").value = "";
  $("total-volume").value = "";
  $("target-pest").value = "";
  $("weather").value = "";
  $("temperature").value = "";
  $("worker-name").value = "";
  $("ppe").value = "";
  $("note").value = "";
}

async function loadMyRecords() {
  const res = await apiGet("mytoday", { userId: state.profile.userId });
  renderMyRecords(res.pesticide || []);
}

function renderMyRecords(records) {
  const box = $("my-records");
  box.innerHTML = "";
  if (records.length === 0) {
    box.appendChild(el("div", "hint", "今日の農薬記録はまだありません"));
    return;
  }
  records.slice().reverse().forEach((r) => {
    const row = el("div", "item");
    const dose = r.希釈倍数 || (r.使用量 ? r.使用量 + r.使用量単位 : "");
    const label = `${r["棟・区画"]} / ${r["農薬の種類・名称"]}（${dose}）`;
    row.appendChild(el("span", "", label));
    const del = el("button", "del", "取消");
    del.type = "button";
    del.addEventListener("click", () => cancelRecord(r.記録ID));
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function cancelRecord(id) {
  const reason = window.prompt("取消理由を入力してください（法定帳簿のため必須。記録自体は残ります）");
  if (!reason) {
    toast("取消理由が未入力のため取消していません");
    return;
  }
  const res = await apiPost({ type: "cancelPesticide", id, reason, userId: state.profile.userId });
  if (!res.ok) {
    toast("⚠ " + (res.error || "取消に失敗しました"));
    return;
  }
  toast("取り消しました（記録は保持されます）");
  await loadMyRecords();
}
