// LAI計算と、写真から葉の面積を出す処理のテスト。node --test test/lai.test.cjs
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { laiCoefficient, laiEstimate, measureLeafArea } = require(path.join(__dirname, "..", "app", "lai-calc.js"));

test("係数は Σ面積 ÷ Σ(葉長×葉幅)。そろっていない葉は数えない", () => {
  const r = laiCoefficient([
    { length: 40, width: 30, area: 312 },   // 1200 → 0.26
    { length: 50, width: 40, area: 520 },   // 2000 → 0.26
    { length: 45, width: "", area: 400 },   // 葉幅なし
  ]);
  assert.strictEqual(r.n, 2);
  assert.ok(Math.abs(r.value - 0.26) < 1e-9);
  assert.strictEqual(laiCoefficient([{}]), null);
});

test("LAIと残す枚数（千葉県マニュアルの例：2.5株/m²で1枝1.2m²ならLAI3）", () => {
  // 係数0.26・40×30cm → 1枚312cm²。1.2m²は約38.5枚
  const r = laiEstimate({ coefficient: 0.26, density: 2.5, leafCount: 38.4615, leaves: [{ length: 40, width: 30 }], targetLai: 3 });
  assert.ok(Math.abs(r.avgLeafCm2 - 312) < 1e-9);
  assert.ok(Math.abs(r.lai - 3) < 1e-3);
  assert.ok(Math.abs(r.keepLeaves - 38.46) < 0.01);
});

test("葉の大きさは数枚の平均。枚数や密度が無ければ出せるものだけ出す", () => {
  const r = laiEstimate({ coefficient: 0.25, leaves: [{ length: 40, width: 30 }, { length: 20, width: 20 }, {}] });
  assert.strictEqual(r.sampleCount, 2);
  assert.ok(Math.abs(r.avgLeafCm2 - (300 + 100) / 2) < 1e-9);
  assert.strictEqual(r.lai, undefined);
  assert.strictEqual(r.keepLeaves, undefined);
  assert.strictEqual(laiEstimate({ coefficient: "", leaves: [{ length: 1, width: 1 }] }), null);
});

// 白地に、黒い正方形と緑の図形を描いた画像を作る
function canvas(w, h) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  return {
    w, h, data,
    rect(x0, y0, rw, rh, rgb) {
      for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) {
        const i = (y * w + x) * 4;
        data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
      }
    },
  };
}

test("緑の画素数 ÷ 黒い正方形の画素数 × 一辺² で面積を出す", () => {
  const c = canvas(600, 400);
  c.rect(20, 20, 100, 100, [15, 15, 15]);        // 基準 10cm 角 = 100×100px
  c.rect(250, 100, 200, 150, [40, 110, 45]);     // 葉 200×150px → 300cm²
  c.rect(470, 300, 30, 20, [70, 150, 60]);       // 離れた小葉 600px → 6cm²
  c.rect(250, 260, 200, 8, [205, 205, 205]);     // 影（灰色）は数えない
  const r = measureLeafArea(c.data, c.w, c.h, 10);
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.areaCm2 - 306) < 1e-6, String(r.areaCm2));
  assert.deepStrictEqual(r.warnings, []);
});

test("濃い緑の葉（暗くても彩度が高い）は黒の基準と取り違えない", () => {
  const c = canvas(600, 400);
  c.rect(20, 20, 100, 100, [10, 10, 10]);
  c.rect(250, 100, 200, 200, [20, 60, 25]);      // 暗い濃緑 40000px → 400cm²
  const r = measureLeafArea(c.data, c.w, c.h, 10);
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.areaCm2 - 400) < 1e-6, String(r.areaCm2));
});

test("黒い正方形が無ければエラー。細長い黒は基準にしない", () => {
  const c = canvas(400, 300);
  c.rect(10, 10, 300, 20, [10, 10, 10]);         // 細長い黒（机の縁など）
  c.rect(100, 100, 100, 100, [40, 110, 45]);
  const r = measureLeafArea(c.data, c.w, c.h, 10);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /黒い正方形/);
});

test("葉が写真の端で切れていたら知らせる", () => {
  const c = canvas(400, 300);
  c.rect(20, 20, 60, 60, [10, 10, 10]);
  c.rect(300, 100, 100, 100, [40, 110, 45]);     // 右端に接する
  const r = measureLeafArea(c.data, c.w, c.h, 5);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((t) => /端で切れて/.test(t)));
  assert.ok(!r.warnings.some((t) => /小さく写って/.test(t))); // 60×60=3600px は閾値2500を超えるので出ない
});

test("黒い正方形が小さく写っていたら知らせる", () => {
  const c = canvas(400, 300);
  c.rect(20, 20, 40, 40, [10, 10, 10]);          // 1600px
  c.rect(150, 100, 100, 100, [40, 110, 45]);
  const r = measureLeafArea(c.data, c.w, c.h, 5);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((t) => /小さく写って/.test(t)));
  assert.ok(Math.abs(r.areaCm2 - 10000 / 1600 * 25) < 1e-6);
});

test("葉の中の小さな穴（照り返し）は葉として数え、小葉に囲まれた大きな隙間は数えない", () => {
  const c = canvas(800, 600);
  c.rect(20, 20, 100, 100, [10, 10, 10]);
  c.rect(200, 100, 400, 400, [40, 110, 45]);     // 160000px
  c.rect(300, 200, 5, 5, [235, 240, 235]);       // 照り返し 25px（上限320pxより小さい）→埋める
  c.rect(400, 300, 100, 100, [255, 255, 255]);   // 囲まれた隙間 10000px → 埋めない
  const r = measureLeafArea(c.data, c.w, c.h, 10);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.leafPx, 160000 - 10000);
});
