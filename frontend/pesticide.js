"use strict";

const state = {
  masters: null,
  base: null,
  building: null,
  items: [],
  recipeName: "",
  profile: getProfile(),
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  $("use-date").value = formatToday();

  state.masters = await apiGet("masters");

  renderBases();
  renderCrops();
  renderRecipes();
  renderPesticideOptions();
  renderItems();
  await loadMyRecords();

  $("pesticide-name").addEventListener("input", updatePpeHint);
  $("add-item").addEventListener("click", addItem);
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

function findPesticideMaster(name) {
  return (state.masters.pesticides || []).find((p) => p.薬剤名 === name);
}

function updatePpeHint() {
  const name = $("pesticide-name").value.trim();
  const m = findPesticideMaster(name);
  const hint = $("ppe-hint");
  if (m && m["必要な保護具"]) {
    hint.hidden = false;
    hint.textContent = "⚠ 必要な保護具（目安。使用前にラベルで要確認）: " + m["必要な保護具"];
  } else {
    hint.hidden = true;
  }
}

function activeRecipes() {
  return (state.masters.recipes || []).filter((r) => String(r.有効フラグ).toUpperCase() === "TRUE");
}

function recipeItemsOf(recipeId) {
  return (state.masters.recipeItems || [])
    .filter((it) => it.レシピID === recipeId)
    .sort((a, b) => Number(a.表示順) - Number(b.表示順));
}

function renderRecipes() {
  const box = $("recipe-buttons");
  box.innerHTML = "";
  const recipes = activeRecipes();
  if (recipes.length === 0) {
    box.appendChild(el("div", "hint", "登録済みのレシピはありません（スプレッドシートのマスタ_防除レシピで登録できます）"));
    return;
  }
  recipes.forEach((r) => {
    const btn = el("button", "btn", r.レシピ名);
    btn.type = "button";
    btn.addEventListener("click", () => applyRecipe(r));
    box.appendChild(btn);
  });
}

function applyRecipe(recipe) {
  const items = recipeItemsOf(recipe["レシピID"]);
  if (items.length === 0) {
    toast("このレシピには農薬が登録されていません");
    return;
  }
  state.items = items.map((it) => ({
    pesticideName: it.薬剤名,
    dilution: it.希釈倍数 || "",
    amount: it.使用量 || "",
    amountUnit: it.使用量単位 || "",
    totalVolumeL: "",
  }));
  if (!$("target-pest").value.trim() && recipe.対象病害虫) {
    $("target-pest").value = recipe.対象病害虫;
  }
  state.recipeName = recipe.レシピ名;
  renderItems();
  toast(`「${recipe.レシピ名}」の農薬を入力しました（内容は編集できます）`);
}

function addItem() {
  const name = $("pesticide-name").value.trim();
  const dilution = $("dilution").value.trim();
  const amount = $("amount").value;
  const amountUnit = $("amount-unit").value.trim();
  const totalVolumeL = $("total-volume").value;

  if (!name) return toast("農薬を選択または入力してください");
  if (!dilution && !(amount && amountUnit)) {
    return toast("希釈倍数、または使用量と単位のどちらかを入力してください");
  }

  state.items.push({ pesticideName: name, dilution, amount, amountUnit, totalVolumeL });
  $("pesticide-name").value = "";
  $("dilution").value = "";
  $("amount").value = "";
  $("amount-unit").value = "";
  $("total-volume").value = "";
  $("ppe-hint").hidden = true;
  renderItems();
}

function renderItems() {
  const box = $("item-list");
  box.innerHTML = "";
  state.items.forEach((it, i) => {
    const row = el("div", "item");
    const dose = it.dilution || (it.amount ? it.amount + it.amountUnit : "");
    const m = findPesticideMaster(it.pesticideName);
    const ppe = m && m["必要な保護具"] ? "　⚠" + m["必要な保護具"] : "";
    row.appendChild(el("span", "", `${it.pesticideName}（${dose}）${ppe}`));
    const del = el("button", "del", "削除");
    del.type = "button";
    del.addEventListener("click", () => {
      state.items.splice(i, 1);
      renderItems();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function submit() {
  if (!state.base) return toast("拠点を選択してください");
  if (!$("crop-select").value) return toast("農作物の種類を選択してください");
  if (state.items.length === 0) return toast("農薬を1件以上リストに追加してください");

  const payload = {
    type: "pesticide",
    useDate: $("use-date").value,
    base: state.base,
    building: state.building,
    crop: $("crop-select").value,
    targetPest: $("target-pest").value.trim(),
    recipeName: state.recipeName || "",
    recorder: state.profile.displayName,
    userId: state.profile.userId,
    note: $("note").value.trim(),
    items: state.items,
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

function resetForm() {
  state.items = [];
  state.recipeName = "";
  $("target-pest").value = "";
  $("note").value = "";
  renderItems();
}

async function loadMyRecords() {
  const res = await apiGet("mytoday", { userId: state.profile.userId });
  renderMyRecords(res.pesticide || []);
}

function renderMyRecords(records) {
  const box = $("my-records");
  box.innerHTML = "";
  if (records.length === 0) {
    box.appendChild(el("div", "hint", "今日の防除記録はまだありません"));
    return;
  }
  records.slice().reverse().forEach((r) => {
    const row = el("div", "item");
    const names = (r.items || [])
      .map((it) => `${it.薬剤名}（${it.希釈倍数 || (it.使用量 + it.使用量単位)}）`)
      .join("・");
    const label = `${r["棟・区画"]} / ${names}`;
    row.appendChild(el("span", "", label));
    const del = el("button", "del", "取消");
    del.type = "button";
    del.addEventListener("click", () => cancelRecord(r.記録ID));
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function cancelRecord(id) {
  const res = await apiPost({ type: "cancelPesticide", id, userId: state.profile.userId });
  if (!res.ok) {
    toast("⚠ " + (res.error || "取消に失敗しました"));
    return;
  }
  toast("取り消しました");
  await loadMyRecords();
}
