"use strict";

// 数値で測る項目。prevKey は前回値を引くときのシート列名。
// group で画面上のまとまりを分ける（毎回測る基本／数えるだけ／実測に手間がかかる）
const NUM_FIELDS = [
  // 草勢と生育バランスの基本。公的資料が共通して挙げる指標
  { key: "stemDiameter", prevKey: "茎径mm", label: "茎径(mm)", unit: "mm", group: "basic", hint: "生長点15cm下・目安10前後" },
  { key: "trussDistance", prevKey: "生長点花房距離cm", label: "生長点〜開花花房(cm)", unit: "cm", group: "basic", hint: "目安15前後" },
  { key: "plantHeight", prevKey: "草丈cm", label: "草丈(cm)", unit: "cm", group: "basic", hint: "前回差が伸長量" },

  // 数えるだけで測定コストがほぼゼロ。摘葉と草勢の持続性の判断に効く
  { key: "floweringTruss", prevKey: "開花段位", label: "開花段位", unit: "段", group: "count", hint: "7〜10日で1段" },
  { key: "harvestTruss", prevKey: "収穫段位", label: "収穫段位", unit: "段", group: "count", hint: "開花との差6段が目安" },
  { key: "leavesBelowTruss", prevKey: "花房下葉数", label: "花房下の葉数", unit: "枚", group: "count", hint: "適正12枚（摘葉の判断）" },
  { key: "fruitSet", prevKey: "着果数", label: "着果数", unit: "個", group: "count", hint: "" },
  { key: "leafCount", prevKey: "葉数", label: "葉数", unit: "枚", group: "count", hint: "" },

  // ノギス・メジャーが要る項目。時間がある日だけでよい
  { key: "internodeLength", prevKey: "節間長cm", label: "節間長(cm)", unit: "cm", group: "detail", hint: "徒長の判定" },
  { key: "leafLength", prevKey: "葉長cm", label: "葉長(cm)", unit: "cm", group: "detail", hint: "第1花房直下葉" },
  { key: "fruitDiameter", prevKey: "果径mm", label: "果径(mm)", unit: "mm", group: "detail", hint: "果実肥大" },
];

// 障害果。現場で実際に問題になっている（尻腐れ・裂果）ので株ごとに数を残す
const DISORDER_FIELDS = [
  { key: "blossomEndRot", prevKey: "尻腐れ果数", label: "尻腐れ", unit: "個" },
  { key: "cracking", prevKey: "裂果数", label: "裂果", unit: "個" },
  { key: "otherDisorder", prevKey: "その他障害果数", label: "その他", unit: "個" },
];

// 目視での草勢確認。手順書「4A 整枝・誘引_巡回作業」の観察表をそのまま選択肢にしている
const VISUAL_CHECKS = [
  { key: "growingPoint", label: "成長点の形", options: ["やや尖り（正常）", "丸く膨らむ（栄養過多）", "細く弱々しい（弱り）"] },
  { key: "leafAngle", label: "葉の角度", options: ["やや内巻き（正常）", "強く内巻き（栄養過多）", "上向きに開く（弱り）"] },
  { key: "leafColor", label: "葉の色", options: ["中緑（正常）", "濃緑ツヤあり（窒素過多）", "黄緑・黄色（不足・根の異常）"] },
  { key: "truss", label: "花房", options: ["軸が適度・花が均一（正常）", "軸が太く花多い（栄養過多）", "小さく花少ない（弱り）"] },
];

const GROUP_LABELS = {
  basic: "基本（毎回）",
  count: "数える項目",
  detail: "実測（時間があるとき）",
};

const DEFAULT_LABELS = ["A", "B", "C", "D"];

const state = {
  masters: null,
  base: null,
  building: null,
  plants: [],
  lastGrowth: null,   // 同じ場所の前回調査（前回値と増減の表示に使う）
  openDetail: {},     // 株ごとに「実測」「障害果」を開いているか
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
  state.plants.push({ label: next });
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

async function loadLastGrowth() {
  if (!state.base || !state.building) return;
  const res = await apiGet("lastGrowth", {
    base: state.base,
    building: state.building,
    before: $("survey-date").value || formatToday(),
  });
  state.lastGrowth = res.growth || null;
  $("last-info").textContent = state.lastGrowth ? "前回: " + state.lastGrowth.調査日 : "前回の調査なし";
  renderPlants();
}

function lastItemOf(label) {
  if (!state.lastGrowth) return null;
  return (state.lastGrowth.items || []).find((it) => String(it.株ラベル) === String(label)) || null;
}

function diffText(current, previous, unit) {
  const c = parseFloat(current);
  const p = parseFloat(previous);
  if (isNaN(c) || isNaN(p)) return "";
  const d = Math.round((c - p) * 10) / 10;
  return (d >= 0 ? "+" : "") + d + unit;
}

// 数値の入力行。前回値と増減を横に出す
function numRow(p, prev, f) {
  const row = el("div", "num-row");
  row.appendChild(el("label", "num-label", f.label));

  const input = el("input", "num-input");
  input.type = "number";
  input.inputMode = "decimal";
  input.value = p[f.key] || "";

  const diffSpan = el("span", "num-diff");
  const showDiff = () => {
    if (!prev || prev[f.prevKey] === "" || prev[f.prevKey] === undefined) {
      diffSpan.textContent = "";
      return;
    }
    const d = diffText(p[f.key], prev[f.prevKey], f.unit);
    diffSpan.textContent = d ? "（前回 " + prev[f.prevKey] + " → " + d + "）" : "前回 " + prev[f.prevKey];
  };
  showDiff();

  input.addEventListener("input", () => {
    p[f.key] = input.value;
    showDiff();
    if (f.key === "floweringTruss" || f.key === "harvestTruss") updateTrussGap(p);
  });

  row.appendChild(input);
  row.appendChild(diffSpan);
  if (f.hint) row.appendChild(el("span", "num-hint", f.hint));
  return row;
}

// 開花段位と収穫段位の差。岩手県の資料では6段が目安で、草勢が続くかの判断に使う
function updateTrussGap(p) {
  const box = document.getElementById("gap-" + p.label);
  if (!box) return;
  const f = parseFloat(p.floweringTruss);
  const h = parseFloat(p.harvestTruss);
  if (isNaN(f) || isNaN(h)) {
    box.textContent = "";
    box.className = "truss-gap";
    return;
  }
  const gap = f - h;
  box.textContent = "開花と収穫の差 " + gap + "段（目安6段）";
  box.className = "truss-gap" + (gap >= 4 && gap <= 8 ? " ok" : " warn");
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
    labelInput.addEventListener("input", () => { p.label = labelInput.value.trim(); });
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

    // 基本と「数える項目」は常に出す
    ["basic", "count"].forEach((g) => {
      card.appendChild(el("div", "group-label", GROUP_LABELS[g]));
      NUM_FIELDS.filter((f) => f.group === g).forEach((f) => card.appendChild(numRow(p, prev, f)));
      if (g === "count") {
        const gap = el("div", "truss-gap");
        gap.id = "gap-" + p.label;
        card.appendChild(gap);
      }
    });

    // 実測と障害果は畳んでおく（毎回は測らないため）
    const open = !!state.openDetail[p.label];
    const toggle = el("button", "btn-toggle", open ? "▲ 実測・障害果をとじる" : "▼ 実測・障害果を入力する");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      state.openDetail[p.label] = !open;
      renderPlants();
    });
    card.appendChild(toggle);

    if (open) {
      card.appendChild(el("div", "group-label", GROUP_LABELS.detail));
      NUM_FIELDS.filter((f) => f.group === "detail").forEach((f) => card.appendChild(numRow(p, prev, f)));

      card.appendChild(el("div", "group-label", "障害果"));
      DISORDER_FIELDS.forEach((f) => card.appendChild(numRow(p, prev, f)));
      const dm = el("input", "text-input");
      dm.placeholder = "障害果のメモ（症状の出方など）";
      dm.value = p.disorderMemo || "";
      dm.addEventListener("input", () => { p.disorderMemo = dm.value; });
      card.appendChild(dm);
    }

    // 目視での草勢確認（器具がない日でもここだけ埋められる）
    card.appendChild(el("div", "group-label", "目視での草勢確認"));
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

  state.plants.forEach(updateTrussGap);
}

// 何か1つでも入っているか（4株ぶんの枠を出しているので空のまま残ることがある）。
// 「0」は入力された値として扱う（障害果0個の記録に意味があるため）
function hasAnyValue(p) {
  const keys = NUM_FIELDS.map((f) => f.key)
    .concat(DISORDER_FIELDS.map((f) => f.key))
    .concat(VISUAL_CHECKS.map((v) => v.key))
    .concat(["memo", "disorderMemo"]);
  return keys.some((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");
}

async function submit() {
  if (!state.base) return toast("拠点を選択してください");
  const plants = state.plants.filter((p) => p.label);
  if (plants.length === 0) return toast("株ラベルを入力してください");

  const filled = plants.filter(hasAnyValue);
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
  state.openDetail = {};
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
    const items = r.items || [];
    const avg = averageOf(items, "茎径mm");
    const label = `${r["棟・区画"]} / ${items.length}株` + (avg ? `（茎径 平均${avg}mm）` : "");
    row.appendChild(el("span", "grow", label));
    const del = el("button", "del", "取消");
    del.type = "button";
    del.addEventListener("click", () => cancelRecord(r.記録ID));
    row.appendChild(del);
    box.appendChild(row);
  });
}

function averageOf(items, key) {
  const vals = items.map((it) => parseFloat(it[key])).filter((v) => !isNaN(v));
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
