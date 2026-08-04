"use strict";

// 目視での草勢確認。手順書「4A 整枝・誘引_巡回作業」の観察表をそのまま選択肢にしている
const VISUAL_CHECKS = [
  { key: "growingPoint", label: "成長点の形", options: ["やや尖り（正常）", "丸く膨らむ（栄養過多）", "細く弱々しい（弱り）"] },
  { key: "leafAngle", label: "葉の角度", options: ["やや内巻き（正常）", "強く内巻き（栄養過多）", "上向きに開く（弱り）"] },
  { key: "leafColor", label: "葉の色", options: ["中緑（正常）", "濃緑ツヤあり（窒素過多）", "黄緑・黄色（不足・根の異常）"] },
  { key: "truss", label: "花房", options: ["軸が適度・花が均一（正常）", "軸が太く花多い（栄養過多）", "小さく花少ない（弱り）"] },
];

const DEFAULT_LABELS = ["A", "B", "C", "D"];

const state = {
  masters: null,
  base: null,
  building: null,
  crop: "",
  plants: [],   // [{label, stemDiameter, trussDistance, floweringTruss, plantHeight, 目視..., memo}]
  lastGrowth: null, // 同じ場所の前回調査（前回値と伸長量の表示に使う）
  profile: getProfile(),
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  $("survey-date").value = formatToday();

  // 通信を待つ前にイベントを登録する（待っている間のタップを取りこぼさないため）
  $("add-plant").addEventListener("click", () => {
    addPlant();
    renderPlants();
  });
  $("submit").addEventListener("click", submit);
  $("survey-date").addEventListener("change", loadLastGrowth);

  // 既定で4株ぶんの入力欄を出す（公的資料では中庸な株を最低4株みるのが目安）
  DEFAULT_LABELS.forEach((l) => addPlant(l));
  renderPlants();

  state.masters = await loadMasters(function (fresh) {
    state.masters = fresh;
    renderBases();
    renderCrops();
  });
  renderBases();
  renderCrops();

  loadMyRecords();
}

function addPlant(label) {
  const used = state.plants.map((p) => p.label);
  let next = label;
  if (!next) {
    next = DEFAULT_LABELS.find((l) => !used.includes(l)) || String(state.plants.length + 1);
  }
  state.plants.push({ label: next, stemDiameter: "", trussDistance: "", floweringTruss: "", plantHeight: "", memo: "" });
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

// 生育調査は「どの棟の株を測ったか」を特定したいので、棟は1つだけ選ぶ
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
      loadLastGrowth();
    });
    box.appendChild(btn);
  });
  loadLastGrowth();
}

function renderCrops() {
  const sel = $("crop-select");
  const current = sel.value;
  sel.innerHTML = "";
  (state.masters.crops || []).forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.品目名;
    opt.textContent = c.品目名;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

// 同じ場所の前回調査を読み、株ごとの前回値・伸長量を出せるようにする
async function loadLastGrowth() {
  if (!state.base || !state.building) return;
  const res = await apiGet("lastGrowth", {
    base: state.base,
    building: state.building,
    before: $("survey-date").value || formatToday(),
  });
  state.lastGrowth = res.growth || null;
  const info = $("last-info");
  info.textContent = state.lastGrowth
    ? "前回: " + state.lastGrowth.調査日
    : "前回の調査なし";
  renderPlants();
}

function lastItemOf(label) {
  if (!state.lastGrowth) return null;
  return (state.lastGrowth.items || []).find((it) => String(it.株ラベル) === String(label)) || null;
}

// 前回からの差を出す（草丈は伸長量、茎径は増減）
function diffText(current, previous, unit) {
  const c = parseFloat(current);
  const p = parseFloat(previous);
  if (isNaN(c) || isNaN(p)) return "";
  const d = Math.round((c - p) * 10) / 10;
  return (d >= 0 ? "+" : "") + d + unit;
}

function renderPlants() {
  const box = $("plant-list");
  box.innerHTML = "";

  state.plants.forEach((p, i) => {
    const card = el("div", "plant-card");
    const prev = lastItemOf(p.label);

    const head = el("div", "plant-head");
    const labelInput = el("input", "plant-label");
    labelInput.value = p.label;
    labelInput.placeholder = "株";
    labelInput.addEventListener("input", () => {
      p.label = labelInput.value.trim();
    });
    labelInput.addEventListener("change", renderPlants); // 前回値を引き直す
    head.appendChild(labelInput);
    if (prev) head.appendChild(el("span", "prev-note", "前回あり"));
    const del = el("button", "del", "削除");
    del.type = "button";
    del.addEventListener("click", () => {
      state.plants.splice(i, 1);
      renderPlants();
    });
    head.appendChild(del);
    card.appendChild(head);

    // 数値の入力欄。前回値と差を横に出す
    const nums = [
      { key: "stemDiameter", label: "茎径(mm)", prevKey: "茎径mm", unit: "mm", hint: "生長点15cm下・目安10前後" },
      { key: "trussDistance", label: "生長点〜開花花房(cm)", prevKey: "生長点花房距離cm", unit: "cm", hint: "目安15前後" },
      { key: "floweringTruss", label: "開花段位", prevKey: "開花段位", unit: "段", hint: "7〜10日で1段" },
      { key: "plantHeight", label: "草丈(cm)", prevKey: "草丈cm", unit: "cm", hint: "" },
    ];
    nums.forEach((n) => {
      const row = el("div", "num-row");
      row.appendChild(el("label", "num-label", n.label));
      const input = el("input", "num-input");
      input.type = "number";
      input.inputMode = "decimal";
      input.value = p[n.key] || "";
      input.addEventListener("input", () => {
        p[n.key] = input.value;
        const d = prev ? diffText(input.value, prev[n.prevKey], n.unit) : "";
        diffSpan.textContent = d ? "（前回 " + prev[n.prevKey] + " → " + d + "）" : "";
      });
      row.appendChild(input);
      const diffSpan = el("span", "num-diff");
      if (prev && prev[n.prevKey] !== "" && prev[n.prevKey] !== undefined) {
        const d = diffText(p[n.key], prev[n.prevKey], n.unit);
        diffSpan.textContent = d ? "（前回 " + prev[n.prevKey] + " → " + d + "）" : "前回 " + prev[n.prevKey];
      }
      row.appendChild(diffSpan);
      if (n.hint) row.appendChild(el("span", "num-hint", n.hint));
      card.appendChild(row);
    });

    // 目視での草勢確認（器具がない日でもここだけ埋められる）
    VISUAL_CHECKS.forEach((v) => {
      const wrap = el("div", "visual-row");
      wrap.appendChild(el("span", "visual-label", v.label));
      const chips = el("div", "btn-row chip-row");
      v.options.forEach((opt) => {
        const short = opt.replace(/（.*）/, "");
        const btn = el("button", "btn chip" + (p[v.key] === opt ? " active" : ""), short);
        btn.type = "button";
        btn.title = opt;
        btn.addEventListener("click", () => {
          p[v.key] = p[v.key] === opt ? "" : opt; // もう一度押すと解除
          renderPlants();
        });
        chips.appendChild(btn);
      });
      wrap.appendChild(chips);
      card.appendChild(wrap);
    });

    const memo = el("input", "text-input");
    memo.placeholder = "この株のメモ（任意）";
    memo.value = p.memo || "";
    memo.addEventListener("input", () => { p.memo = memo.value; });
    card.appendChild(memo);

    box.appendChild(card);
  });
}

async function submit() {
  if (!state.base) return toast("拠点を選択してください");
  const plants = state.plants.filter((p) => p.label);
  if (plants.length === 0) return toast("株ラベルを入力してください");

  // 何も測っていない株は送らない（4株ぶんの枠を出しているので空のまま残ることがある）
  const filled = plants.filter((p) =>
    p.stemDiameter || p.trussDistance || p.floweringTruss || p.plantHeight ||
    p.growingPoint || p.leafAngle || p.leafColor || p.truss || p.memo
  );
  if (filled.length === 0) return toast("測定値か目視の項目を1つ以上入力してください");

  const payload = {
    type: "growth",
    surveyDate: $("survey-date").value || formatToday(),
    base: state.base,
    building: state.building,
    crop: $("crop-select").value,
    recorder: state.profile.displayName,
    userId: state.profile.userId,
    note: $("note").value.trim(),
    items: filled,
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
    await loadLastGrowth();
  } catch (err) {
    console.error(err);
    toast("⚠ 送信に失敗しました");
  } finally {
    $("submit").disabled = false;
  }
}

function resetForm() {
  state.plants = [];
  DEFAULT_LABELS.forEach((l) => addPlant(l));
  $("note").value = "";
  renderPlants();
}

async function loadMyRecords() {
  const res = await apiGet("mytoday", { userId: state.profile.userId });
  renderMyRecords(res.growth || []);
}

function renderMyRecords(records) {
  const box = $("my-records");
  box.innerHTML = "";
  if (records.length === 0) {
    box.appendChild(el("div", "hint", "今日の調査はまだありません"));
    return;
  }
  records.slice().reverse().forEach((r) => {
    const row = el("div", "item");
    const n = (r.items || []).length;
    const avg = averageStem(r.items || []);
    const label = `${r["棟・区画"]} / ${n}株` + (avg ? `（茎径 平均${avg}mm）` : "");
    row.appendChild(el("span", "grow", label));
    const del = el("button", "del", "取消");
    del.type = "button";
    del.addEventListener("click", () => cancelRecord(r.記録ID));
    row.appendChild(del);
    box.appendChild(row);
  });
}

function averageStem(items) {
  const vals = items.map((it) => parseFloat(it.茎径mm)).filter((v) => !isNaN(v));
  if (vals.length === 0) return "";
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

async function cancelRecord(id) {
  const res = await apiPost({ type: "cancelGrowth", id, userId: state.profile.userId });
  if (!res.ok) {
    toast("⚠ " + (res.error || "取消に失敗しました"));
    return;
  }
  toast("取り消しました");
  await loadMyRecords();
}
