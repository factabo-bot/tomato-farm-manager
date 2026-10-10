"use strict";

const state = {
  masters: null,
  base: null,
  buildings: new Set(), // 収穫などで複数の棟をまとめて回ることがあるので複数選択
  workTypes: new Set(), // その日にやった作業をまとめて記録するので複数選択
  cells: new Set(), // 選んだ列。「2号棟-9手前」の形（棟-列番号＋手前／奥）
  heatWork: null, // 列マップの色に使う作業（最後に選んだもの）
  profile: getProfile(),
  checking: null, // 確認中の散布区分（"防除" / "葉面散布"）。未確認のときは null
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

  // 手元のストアだけを見て即座に描く。取り込みが済んだら描き直す
  onStoreChange = loadMyRecords;
  loadMyRecords();

  // キャッシュがあれば即座に描画し、最新版が届いて中身が変わっていたら描き直す
  state.masters = await loadMasters(function (fresh) {
    state.masters = fresh;
    renderBases();
    renderWorkTypes();
    renderBench();
  });

  renderBases();
  renderWorkTypes();
  renderBench();
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
      renderBench();
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

  // 棟が多い拠点だけ一括選択を出す（2〜3棟なら1つずつ押しても手間は同じで、行が増えるだけなので出さない）
  const bulk = $("building-bulk");
  bulk.innerHTML = "";
  if (buildings.length > 3) {
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
  // 外した棟の列は選択から落とす
  [...state.cells].forEach((c) => { if (!state.buildings.has(parseCell(c).building)) state.cells.delete(c); });
  renderBench();
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
    const name = w.作業名;
    const btn = el("button", "btn" + (state.workTypes.has(name) ? " active" : ""), name);
    btn.type = "button";
    btn.addEventListener("click", () => {
      if (state.workTypes.has(name)) {
        state.workTypes.delete(name);
        if (state.heatWork === name) state.heatWork = lastHeatableWork();
      } else {
        state.workTypes.add(name);
        if (name !== "その他") state.heatWork = name;
      }
      renderWorkTypes();
      renderBench();
    });
    box.appendChild(btn);
  });
  $("work-detail").hidden = !state.workTypes.has("その他");
}

// 選んだ作業を、マスタの表示順で「誘引、葉かき」のように1つにまとめる。
// 1件の記録にするのは、開始・終了時刻を作業ごとに分けられず、分けると時間を二重に数えるため
function joinedWorkTypes() {
  return activeWorkTypes().map((w) => w.作業名).filter((n) => state.workTypes.has(n)).join(PURPOSE_SEPARATOR);
}

// ---------- 列マップとヒートマップ（farm-work-log の配置図を移したもの） ----------
// 経過日数の数え方は履歴画面の「列の経過」と共通なので common.js に置いている

function benchLayout(building) {
  return benchLayoutOf(state.base, building);
}

// 最後に選んだ作業が外されたとき、残っている作業から色に使うものを選び直す
function lastHeatableWork() {
  const rest = [...state.workTypes].filter((w) => w !== "その他");
  return rest.length ? rest[rest.length - 1] : null;
}

function renderBench() {
  const area = $("bench-area");
  if (!area || !state.masters || !state.base) return;
  // 押すたびに描き直すので、棟ごとの横スクロールの位置を覚えておいて戻す
  const scrolls = {};
  area.querySelectorAll(".bench-scroll").forEach((s) => { scrolls[s.dataset.building] = s.scrollLeft; });
  area.innerHTML = "";
  const last = lastDoneByCell(state.base);
  const heat = state.heatWork;

  // 作業を選ぶまでは色を付けない。以前は列ごとに全作業の略字と日数を並べていたが、
  // 1列に7〜8個のチップが縦に積まれて読めず、画面がごちゃつくだけだった（2026-10-07 ユーザー指摘）。
  // 全作業の経過は履歴の「列の経過」で棟ごとに見る。色の意味の説明文も要らない（同日 ユーザー）
  $("age-legend").hidden = !heat;

  const buildings = buildingsOfBase(state.masters, state.base).map((b) => b.棟区画名).filter((n) => state.buildings.has(n));
  if (buildings.length === 0) {
    area.appendChild(el("p", "hint", "② で棟を選ぶと、ここに列が出ます"));
    return;
  }

  buildings.forEach((b) => {
    const L = benchLayout(b);
    const head = el("div", "bench-head");
    head.appendChild(el("span", "bench-title", b));
    const n = [...state.cells].filter((c) => parseCell(c).building === b).length;
    head.appendChild(el("span", "bench-count", n ? n + "列を選択" : "未選択"));
    area.appendChild(head);
    if (!L) {
      area.appendChild(el("p", "hint", "この棟は列の並びが未登録です（列を選ばずに記録できます）"));
      return;
    }

    // 一括選択。「すべて」を左端に置く（いちばん使うため。2026-10-07 ユーザー）。中央通路のある棟は左右半分も選べる
    const bulk = el("div", "btn-row bench-bulk");
    const selectRange = (from, to, on) => {
      for (let col = from; col <= to; col++) {
        positionsOf(L, col).forEach((pos) => {
          const c = cellToken(b, col, pos, L);
          on ? state.cells.add(c) : state.cells.delete(c);
        });
      }
      renderBench();
    };
    const addBulk = (label, fn) => {
      const btn = el("button", "btn chip", label);
      btn.type = "button";
      btn.addEventListener("click", fn);
      bulk.appendChild(btn);
    };
    addBulk("すべて", () => selectRange(1, L.cols, true));
    if (L.centerAfter) {
      addBulk(`左 1〜${L.centerAfter}`, () => selectRange(1, L.centerAfter, true));
      addBulk(`右 ${L.centerAfter + 1}〜${L.cols}`, () => selectRange(L.centerAfter + 1, L.cols, true));
    }
    addBulk("解除", () => selectRange(1, L.cols, false));
    area.appendChild(bulk);

    // 入口から見た向きで描く：列は左右に並び、奥が上・手前が下。手前／奥に分かれない列は上下通しの1マス。
    // 列の幅は指で押せる大きさを下限にし、入りきらない棟は横にスクロールさせる
    const scroll = el("div", "bench-scroll");
    scroll.dataset.building = b;
    const grid = el("div", "bench-grid");
    const template = [];
    let gc = 0; // grid の列番号（通路の隙間も1列として数える）
    for (let col = 1; col <= L.cols; col++) {
      template.push("minmax(46px, 1fr)");
      gc++;
      const at = (node, row, span) => {
        node.style.gridColumn = String(gc);
        node.style.gridRow = span ? row + " / span " + span : String(row);
        grid.appendChild(node);
      };
      at(el("span", "bench-label", colLabel(L, col)), 1);
      const split = positionsOf(L, col).length > 1;
      // 上が奥、下が手前
      const order = split ? ["奥", "手前"] : [""];
      order.forEach((pos, i) => {
        const token = cellToken(b, col, pos, L);
        const cell = el("button", "bench-cell" + (state.cells.has(token) ? " picked" : ""));
        cell.type = "button";
        if (pos) cell.appendChild(el("span", "bench-pos", pos));
        if (heat) {
          const date = last.get(token + "|" + heat);
          if (date) {
            const a = ageStep(date);
            cell.classList.add("age" + a.step);
            cell.appendChild(el("span", "bench-days", a.text + "日"));
            cell.title = "最後にやった日 " + date;
          } else {
            cell.appendChild(el("span", "bench-none", "なし"));
          }
        }
        cell.addEventListener("click", () => {
          state.cells.has(token) ? state.cells.delete(token) : state.cells.add(token);
          renderBench();
        });
        at(cell, split ? 2 + i : 2, split ? 0 : 2);
      });
      // 列の後ろの通路。中央通路は広めに取り、点線で示す
      if (col < L.cols && (L.centerAfter === col || (L.aisleAfter || []).includes(col))) {
        const center = L.centerAfter === col;
        template.push(center ? "18px" : "8px");
        gc++;
        if (center) {
          const line = el("div", "bench-center-line");
          line.style.gridColumn = String(gc);
          line.style.gridRow = "1 / span 3";
          grid.appendChild(line);
        }
      }
    }
    grid.style.gridTemplateColumns = template.join(" ");
    scroll.appendChild(grid);
    area.appendChild(scroll);
    if (scrolls[b]) scroll.scrollLeft = scrolls[b];
  });
}

// 選んだ列を、棟の並び・列番号・手前→奥の順に並べて1つの文字列にする
function joinedCells() {
  const order = buildingsOfBase(state.masters, state.base).map((b) => b.棟区画名);
  return [...state.cells]
    .map(parseCell)
    .filter((c) => state.buildings.has(c.building))
    .sort((a, b) => order.indexOf(a.building) - order.indexOf(b.building) || a.col - b.col || (a.pos === "奥") - (b.pos === "奥"))
    .map((c) => cellToken(c.building, c.col, c.pos, benchLayout(c.building)))
    .join(PURPOSE_SEPARATOR);
}

// ---------- 防除・葉面散布の確認（散布記録は散布画面が持つので、ここでは有無だけ見る） ----------

function clearSprayStatus() {
  state.checking = null;
  const box = $("spray-status");
  box.hidden = true;
  box.innerHTML = "";
}

// 散布記録は手元のストアにあるので、押した瞬間に答えが出る（通信しない）
function checkSpray(kubun) {
  if (!state.base) return toast("拠点を選択してください");
  state.checking = kubun;
  const date = $("work-date").value || formatToday();
  renderSprayStatus(spraysOn(date), kubun, date);
}

function spraysOn(date) {
  return storeRead("spray").filter((r) => recordDate("spray", r) === date && r.状態 !== "取消");
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

// 確認済みの表示を、いまの日付・場所で出し直す
function refreshSprayStatus() {
  if (!state.checking) return;
  const date = $("work-date").value || formatToday();
  renderSprayStatus(spraysOn(date), state.checking, date);
}

function renderSprayStatus(list, kubun, date) {
  const box = $("spray-status");
  const hits = list.filter((r) => matchesKubun(r, kubun) && matchesPlace(r));
  const when = date === formatToday() ? "今日" : date;
  box.innerHTML = "";
  box.hidden = false;

  if (hits.length === 0) {
    box.className = "spray-status missing";
    box.appendChild(el("div", "spray-status-head", `${when}の${placeLabel()}に${kubun}の散布記録はまだありません`));
    box.appendChild(sprayLink("散布記録へ", date, kubun));
    return;
  }

  box.className = "spray-status found";
  box.appendChild(el("div", "spray-status-head", `✓ ${when}の${kubun}は散布記録に登録済みです`));
  hits.forEach((r) => {
    const names = (r.items || []).map((it) => it.資材名).filter(Boolean).join("・");
    const time = timeLabel(r.開始時刻);
    box.appendChild(el("div", "spray-status-row", `${time ? time + " " : ""}${r["棟・区画"]} / ${names || "（資材未登録）"}`));
  });
  box.appendChild(sprayLink("散布記録へ", date, kubun));
}

async function submit() {
  if (!state.base) return toast("拠点を選択してください");
  if (state.buildings.size === 0) return toast("棟・区画を選択してください");
  if (state.workTypes.size === 0) return toast("作業を選択してください");
  if (state.workTypes.has("その他") && !$("work-detail").value.trim()) {
    return toast("作業内容を記入してください");
  }

  const payload = {
    clientId: newClientId(),
    workDate: $("work-date").value || formatToday(),
    base: state.base,
    // 複数の棟をまとめて回った場合は「1号棟、2号棟」のように1つの記録にまとめる
    building: [...state.buildings].join(PURPOSE_SEPARATOR),
    columns: joinedCells(),
    workType: joinedWorkTypes(),
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

  // 先に手元へ書いて画面に出す。ここまで通信しないので待ち時間はゼロ
  storeAdd("work", {
    clientId: payload.clientId,
    作業日: payload.workDate,
    記録日時: nowTimestamp(),
    拠点: payload.base,
    "棟・区画": payload.building,
    列: payload.columns,
    作業分類: payload.workType,
    作業詳細: payload.workDetail,
    開始時刻: payload.startTime,
    終了時刻: payload.endTime,
    所要時間分: payload.durationMin,
    数量: payload.quantity,
    数量単位: payload.quantityUnit,
    記録者: payload.recorder,
    userId: payload.userId,
    備考: payload.note,
    状態: "未同期",
  }, payload);
  toast("✓ 記録しました");
  resetForm();
  loadMyRecords();

  // 送信は裏で。失敗してもキューに残るので記録は消えない
  sendRecord("work", payload, loadMyRecords);
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
  state.workTypes.clear();
  state.cells.clear();
  state.heatWork = null;
  $("work-detail").value = "";
  $("work-detail").hidden = true;
  $("start-time").value = "";
  $("end-time").value = "";
  $("quantity").value = "";
  $("quantity-unit").value = "";
  $("note").value = "";
  renderWorkTypes();
  renderBench();
}

// 今日ぶんの自分の記録をストアから取り出す
function todayMine(kind) {
  const today = formatToday();
  const uid = state.profile.userId;
  return storeRead(kind).filter(
    (r) => recordDate(kind, r) === today && r.状態 !== "取消" && (r.userId || uid) === uid
  );
}

function loadMyRecords() {
  renderMyRecords(todayMine("work"), todayMine("spray"));
  renderBench();
  refreshSprayStatus(); // 散布が増減したら確認欄も追従させる
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
    label: `${r["棟・区画"]}${r.列 ? "（" + splitList(r.列).length + "列）" : ""} / ${r.作業分類}${r.作業詳細 ? "（" + r.作業詳細 + "）" : ""}`,
    rec: r,
    kind: "work",
  }));

  sprays.forEach((r) => {
    const names = (r.items || []).map((it) => it.資材名).filter(Boolean).join("・");
    const kubun = r.散布区分 ? `[${r.散布区分}] ` : "";
    rows.push({
      time: timeLabel(r.開始時刻) || timeLabel(r.更新日時),
      label: `${kubun}${r["棟・区画"]} / ${names || "（資材未登録）"}`,
      rec: r,
      kind: "spray",
    });
  });

  rows.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

  rows.forEach((r) => {
    const pending = !r.rec.記録ID;
    const row = el("div", "item" + (pending ? " pending" : ""));
    row.appendChild(el("span", "grow", `${r.time} ${r.label}`));

    // まだ送れていない記録は、送信済みと区別が付くようにしておく
    if (pending) {
      const mark = r.rec.状態 === "送信エラー" ? "送信エラー" : "未送信";
      row.appendChild(el("span", "pending-mark", mark));
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
      cancelStored(r.kind, r.rec);
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

// 取消も手元を先に直す。サーバーへの連絡は裏で送る
function cancelStored(kind, rec) {
  storePatch(kind, recordKey(rec), { 状態: "取消" });
  loadMyRecords();

  if (!rec.記録ID) {
    // まだ送っていない記録なので、キューに残っている送信も取り下げる
    dropQueuedRecord(rec.clientId);
    toast("取り消しました");
    return;
  }
  toast(kind === "spray" ? "散布記録を取り消しました" : "取り消しました");
  sendCancel(kind, rec.記録ID, state.profile.userId, loadMyRecords);
}

