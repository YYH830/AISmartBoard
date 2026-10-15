/* eslint-disable */
/**
 * 猫猫挂件的无界面回归测试：动作轮换 / 随机节奏 / 点击拖拽 交互。
 *
 * 做法：把 index.html 里那段 IIFE 原样抽出来，喂一套最小 DOM 桩，
 * 再用假时钟推进时间 —— 不用真的等十几分钟，就能观察长时间行为。
 *
 * 两个关键手段，缺一个测试就会变得不可信：
 *   1) 假时钟 —— 接管 performance.now / setTimeout / clearTimeout / rAF。
 *   2) 假 Math.random —— 动作「停留多久」和「要不要换位置」都靠随机数决定，
 *      不把它控制住，就只能写出"大概也许"的断言。这里把 Math 注入进去，
 *      用固定值或可复现的伪随机替换 random，于是随机变成确定性、失败能稳定重现。
 *
 * 每个场景都新建一个实例（独立的时钟、定时器、localStorage），
 * 避免上一个场景的状态（定时器、动作）漏进来干扰判断。
 *
 * 用法：node test_rotation.js        （有失败项时退出码为 1）
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const code = blocks.find((c) => c.includes('CAT_ACTIONS') && c.includes('catLayer'));
if (!code) { console.error('没找到猫猫脚本'); process.exit(1); }

/* ---------------- 从源码里解析常量，让期望值跟着实现走 ----------------
   不在测试里另抄一份：抄了就会过期（上一版写死了动作个数，加动作后一直误报）。 */
const ROTATION = (function () {
  const m = /var\s+ROTATION\s*=\s*\[([^\]]*)\]/.exec(code);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();
/** 会真的位移的动作（走路）；双击打断它之后必须退回待机，不能原地迈腿 */
const MOVING = new Set(
  [...code.matchAll(/(\w+)\s*:\s*\{[^}]*?\bmoves\s*:\s*true/g)].map((m) => m[1])
);
/** 动作停留时长的随机区间（秒） */
const RANGE = (function () {
  const lo = /var\s+SWITCH_MIN_SEC\s*=\s*([\d.]+)/.exec(code);
  const hi = /var\s+SWITCH_MAX_SEC\s*=\s*([\d.]+)/.exec(code);
  return lo && hi ? { min: +lo[1], max: +hi[1] } : null;
})();
/** 「溜达到别处」的概率 */
const TELEPORT_P = (function () {
  const m = /var\s+TELEPORT_P\s*=\s*([\d.]+)/.exec(code);
  return m ? +m[1] : 0.5;
})();
if (!ROTATION.length || !RANGE) { console.error('解析源码常量失败'); process.exit(1); }

/* ---------------- 断言 ---------------- */
let pass = 0;
let fail = 0;
const line = (s) => console.log(s);
/** 用 [OK]/[FAIL] 而不是 ✓/✗：Windows 控制台按 GBK 解码时会把这些符号糟蹋成乱码，
   纯 ASCII 标记能让输出在哪儿都看得很清楚。 */
function check(ok, msg) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${msg}`);
}

line(`ROTATION（${ROTATION.length} 个动作）: ${ROTATION.join(' → ')}`);
line(`会位移的动作: ${[...MOVING].join(', ') || '(无)'}`);
line(`动作停留时长区间: ${RANGE.min}s ~ ${RANGE.max}s，换位置概率 ${TELEPORT_P}`);

/* ---------------- 随机数工具 ---------------- */

/** 固定值随机：所有 Math.random() 都返回 v。
 *  想让它「必定换位置」就给个 < TELEPORT_P 的值，想「必定不换」就给个 ≥ 的值。 */
function fixedRandom(v) { return () => v; }

/** 可复现的伪随机（mulberry32）。用来验证「确实在随机」——
 *  同一颗种子跑出同一条时间线，失败时能稳定重现，而不是"这次恰好过了"。 */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 交给被测代码的假 Math：其余方法照用真的，只把 random 换掉。 */
function fakeMath(randomFn) {
  const m = Object.create(Math);
  m.random = randomFn;
  return m;
}

/**
 * 造一只全新的猫（独立的时钟、定时器、localStorage）。
 * @param {object} [presetStore] 预置 localStorage 内容，用来模拟"用户之前存过的旧配置"
 * @param {function} [randomFn]  替换 Math.random；不传就用可复现的伪随机
 */
function makeCat(presetStore, randomFn) {
  let now = 0;
  const rafs = [];
  const timers = [];
  const store = Object.assign({}, presetStore);

  const makeEl = () => ({
    style: {}, dataset: {}, children: [], src: '', className: '',
    naturalWidth: 0, naturalHeight: 0, offsetWidth: 72,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this._h = this._h || {})[t] = fn; },
    setAttribute() {}, getAttribute() { return null; },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return { left: 100, top: 100, width: 72, height: 69, right: 172, bottom: 169 }; }
  });
  const layerEl = makeEl();

  const win = {
    addEventListener() {}, innerWidth: 1440, innerHeight: 900,
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
    setTimeout: (fn, ms) => { const t = { fn, at: now + (ms || 0), done: false }; timers.push(t); return t; },
    // clearTimeout 必须真的生效：双击会清掉「单击延时器」，桩里若不生效，
    // 那个本该被取消的"换动作"还会照跑，断言就会莫名其妙地失败
    clearTimeout: (t) => { if (t) t.done = true; }
  };

  const fn = new Function(
    'window', 'document', 'localStorage', 'performance',
    'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'console', 'Math',
    `${code}\n;return window.cat;`
  );
  const api = fn(
    win,
    { readyState: 'complete', getElementById: (id) => (id === 'catLayer' ? layerEl : null), querySelector: () => null, createElement: makeEl, addEventListener() {} },
    { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    { now: () => now },
    win.requestAnimationFrame, win.setTimeout, win.clearTimeout,
    { log() {} },
    fakeMath(randomFn || seededRandom(1))
  );

  /** 推进一帧：加上 16ms，然后按时间顺序触发到期的定时器与 rAF */
  const frame = () => {
    now += 16;
    for (const t of timers) if (!t.done && now >= t.at) { t.done = true; t.fn(); }
    const f = rafs.shift();
    if (f) f(now);
  };

  return {
    api,
    store,                                   // 直接看存档写了什么（验证配置项是否已移除）
    el: layerEl.children[0],                 // 就是那只猫
    nowMs() { return now; },

    /** 推进 ms 毫秒，逐帧处理 */
    run(ms) { for (let e = 0; e < ms; e += 16) frame(); },

    /** 模拟一次真实的鼠标单击（按下 → 松开，中间不移动），并等单击判定走完 */
    click() {
      const h = this.el._h;
      h.pointerdown({ button: 0, pointerId: 1, clientX: 200, clientY: 300, preventDefault() {} });
      for (let e = 0; e < 64; e += 16) frame();
      h.pointerup({ type: 'pointerup', pointerId: 1, clientX: 200, clientY: 300 });
      for (let e = 0; e < 256; e += 16) frame();     // 等 230ms 的单击判定
    },

    /** 模拟一次「快速单击」（按下→松开，不越过双击判定窗口） */
    clickQuick() {
      const h = this.el._h;
      h.pointerdown({ button: 0, pointerId: 1, clientX: 200, clientY: 300, preventDefault() {} });
      now += 16;
      h.pointerup({ type: 'pointerup', pointerId: 1, clientX: 200, clientY: 300 });
      now += 16;
    },

    /** 双击（两下都落在双击判定窗口内），并等瞬移的淡出 → 换位 → 淡入走完 */
    doubleClick() { this.clickQuick(); this.clickQuick(); this.run(600); },

    /** 模拟一次拖拽（按下 → 移动 → 松开） */
    drag(dx = 120) {
      const h = this.el._h;
      h.pointerdown({ button: 0, pointerId: 1, clientX: 200, clientY: 300, preventDefault() {} });
      h.pointermove({ clientX: 200 + dx, clientY: 300 });
      now += 16;
      h.pointerup({ type: 'pointerup', pointerId: 1, clientX: 200 + dx, clientY: 300 });
      now += 16;
    },

    /** 记录动作变化时间线（给人看的诊断信息） */
    trace(ms) {
      const out = [];
      let last = api.state().action;
      out.push(`${(now / 1000).toFixed(1)}s:${last}`);
      for (let e = 0; e < ms; e += 16) {
        frame();
        const a = api.state().action;
        if (a !== last) { out.push(`${(now / 1000).toFixed(1)}s:${a}`); last = a; }
      }
      return out;
    }
  };
}

/* ============================================================================
 * 场景 1：动作停留时长是随机的，且落在设定区间内
 * ========================================================================== */
line('\n=== 场景1 停留时长随机，且落在区间内 ===');
{
  // 随机数恒为下界 → 取到区间下界；恒为上界 → 取到区间上界
  const cMin = makeCat(null, fixedRandom(0));
  cMin.api.next();                                  // 手动切一次，触发重掷
  const gotMin = cMin.api.state().switchSec;
  check(Math.abs(gotMin - RANGE.min) < 0.05,
    `random=0 → 停留 ${gotMin}s，取到区间下界 ${RANGE.min}s`);

  const cMax = makeCat(null, fixedRandom(1));
  cMax.api.next();
  const gotMax = cMax.api.state().switchSec;
  check(Math.abs(gotMax - RANGE.max) < 0.05,
    `random=1 → 停留 ${gotMax}s，取到区间上界 ${RANGE.max}s`);

  // 真的在随机：连切多次应出现大量不同取值
  const c = makeCat(null, seededRandom(20261015));
  const vals = new Set();
  for (let i = 0; i < 40; i++) { c.api.next(); vals.add(c.api.state().switchSec); }
  const inRange = [...vals].every((v) => v >= RANGE.min - 0.05 && v <= RANGE.max + 0.05);
  check([...vals].length >= 30,
    `连切 40 次得到 ${[...vals].length} 个不同的停留时长（确实在随机，不是固定值）`);
  check(inRange, `全部落在 ${RANGE.min}~${RANGE.max}s 区间内`);
}

/* ============================================================================
 * 场景 2：自动切换按随机节奏发生（不再是固定间隔）
 * ========================================================================== */
line('\n=== 场景2 自动切换的节奏 ===');
{
  const c = makeCat(null, seededRandom(2026));
  line('  6 分钟时间线: ' + c.trace(360000).join('  '));

  // 再跑 10 分钟，采样「这一轮要停留多久」的变化
  const vals = [];
  let last = null;
  for (let t = 0; t < 600000; t += 250) {
    c.run(250);
    const s = c.api.state().switchSec;
    if (s !== last) { vals.push(s); last = s; }
  }
  const distinct = new Set(vals).size;
  const spread = Math.max(...vals) - Math.min(...vals);
  const inRange = vals.every((v) => v >= RANGE.min - 0.05 && v <= RANGE.max + 0.05);
  check(vals.length >= 5, `16 分钟内换了 ${vals.length} 次停留时长`);
  check(inRange, `每次都在 ${RANGE.min}~${RANGE.max}s 区间内`);
  check(distinct >= 3, `出现 ${distinct} 个不同取值（间隔长短不一）`);
  check(spread > (RANGE.max - RANGE.min) * 0.25, `取值跨度 ${spread.toFixed(1)}s（不是固定间隔）`);
}

/* ============================================================================
 * 场景 3：单击换动作 —— 按 ROTATION 推进，且循环对称
 * ========================================================================== */
line('\n=== 场景3 单击换动作 ===');
{
  const c = makeCat(null, fixedRandom(0.99));       // 不换位置，避免干扰
  const seq = [c.api.state().action];
  for (let i = 0; i < ROTATION.length; i++) seq.push(c.api.next());
  const expect = ROTATION.concat(ROTATION[0]);
  check(seq.join(',') === expect.join(','),
    `连切 ${ROTATION.length} 次 = ${seq.join(' → ')}（正好一圈回到起点）`);

  // 走真实的鼠标路径（onUp → onCatClick），而不是直接调 api.next
  const c2 = makeCat(null, fixedRandom(0.99));
  const before = c2.api.state().action;
  c2.click();
  const after = c2.api.state().action;
  const exp = ROTATION[(ROTATION.indexOf(before) + 1) % ROTATION.length];
  check(after === exp, `鼠标单击：${before} → ${after}（期望 ${exp}）`);
}

/* ============================================================================
 * 场景 4：单击不挪窝 —— 哪怕随机数偏向"换位置"
 * ========================================================================== */
line('\n=== 场景4 单击不该把猫挪走 ===');
{
  let moved = 0;
  for (let i = 0; i < 20; i++) {
    // 0.01 < 概率 → 如果是自动切换，这一下必定换位置；单击则必须按住不动
    const c = makeCat(null, fixedRandom(0.01));
    const before = c.api.where();
    c.api.next();
    c.click();
    const after = c.api.where();
    if (Math.abs(after.x - before.x) > 60 || Math.abs(after.y - before.y) > 40) moved++;
  }
  check(moved === 0, `20 次单击（随机数偏向换位置）里挪窝 ${moved} 次`);
}

/* ============================================================================
 * 场景 5：自动换动作时会「溜达到别处」
 * ========================================================================== */
line('\n=== 场景5 自动换动作时换位置 ===');
{
  const c = makeCat(null, fixedRandom(0.1));        // 0.1 < 概率 → 每次都掷中
  const y0 = c.api.where().y;
  let maxDy = 0;
  // 第 1 次自动切换进的是"走路"（靠腿移动，不算瞬移），
  // 要走完那一段才轮到第 2 次切换 —— 所以这里要跑够久
  for (let t = 0; t < 90000; t += 200) {
    c.run(200);
    maxDy = Math.max(maxDy, Math.abs(c.api.where().y - y0));
  }
  check(maxDy > 40, `纵向最大偏移 ${maxDy.toFixed(0)}px（确实换了地方）`);
  check(!MOVING.has(c.api.state().action),
    `落地后播的是新动作（${c.api.state().action}，原地动作）`);
}

/* ============================================================================
 * 场景 6：随机数偏向「不换位置」时，猫安分守己
 * ========================================================================== */
line('\n=== 场景6 随机数偏向不换位置时，猫待着不动 ===');
{
  const c = makeCat(null, fixedRandom(0.99));       // 0.99 ≥ 概率 → 从不换位置
  const y0 = c.api.where().y;
  let maxDy = 0;
  for (let t = 0; t < 300000; t += 500) {
    c.run(500);
    maxDy = Math.max(maxDy, Math.abs(c.api.where().y - y0));
  }
  check(maxDy < 1, `5 分钟内纵向偏移 ${maxDy.toFixed(1)}px（没挪窝）`);
}

/* ============================================================================
 * 场景 7：双击 = 随机换个位置（不再回出生点）
 * ========================================================================== */
line('\n=== 场景7 双击 = 随机换位置 ===');
{
  // 新实例没存过位置，就停在出生点 —— 用它的坐标当参照，别调 api.home()（那会把猫挪走）
  const HOME = makeCat(null, fixedRandom(0.5)).api.where();
  line(`  出生点 = (${HOME.x}, ${HOME.y})`);

  /** 把猫摆到 (sx, sy)，双击一次，返回前后位置与落地后的动作 */
  const dbl = (randomFn, sx, sy) => {
    const c = makeCat(null, randomFn);
    c.api.park(sx, sy);
    const before = c.api.where();
    c.doubleClick();
    return { before, after: c.api.where(), action: c.api.state().action };
  };

  const A = dbl(fixedRandom(0.1), 600, 400);
  const B = dbl(fixedRandom(0.9), 600, 400);

  check(Math.abs(A.after.x - A.before.x) > 60 || Math.abs(A.after.y - A.before.y) > 40,
    `双击把猫挪走了：(600, 400) → (${A.after.x}, ${A.after.y})`);
  check(!(A.after.x === HOME.x && A.after.y === HOME.y),
    `没回到出生点（现在在 (${A.after.x}, ${A.after.y})，出生点 (${HOME.x}, ${HOME.y})）`);
  check(A.after.x !== B.after.x || A.after.y !== B.after.y,
    `换两组随机数落点不同：(${A.after.x}, ${A.after.y}) vs (${B.after.x}, ${B.after.y})（确实是随机的）`);
  check(A.action === 'idle',
    `双击不改动作：摆着待机双击后仍是 ${A.action}`);

  // 猫正在走路时双击：腿已经断了，必须退回待机，不能原地迈腿
  const c3 = makeCat(null, fixedRandom(0.9));
  c3.api.next();                                    // 轮到会位移的那个动作
  const wasMoving = MOVING.has(c3.api.state().action);
  const act = c3.api.state().action;
  c3.doubleClick();
  const nowAct = c3.api.state().action;
  check(!wasMoving || nowAct !== act,
    `双击打断走路：${act} → ${nowAct}（不会卡在原地迈腿）`);
}

/* ============================================================================
 * 场景 8：拖拽没有被破坏
 * ========================================================================== */
line('\n=== 场景8 拖拽仍然正常 ===');
{
  const c = makeCat(null, fixedRandom(0.99));
  const before = c.api.where();
  c.drag(150);
  const after = c.api.where();
  check(Math.abs(after.x - before.x) > 100, `拖拽后 x=${before.x} → ${after.x}（跟着走了）`);
  check(c.api.state().action === 'idle', `拖完是站姿（${c.api.state().action}）`);
  check(c.api.state().dragging === false, '拖拽状态已结束');
}

/* ============================================================================
 * 场景 9：「动作切换」设置项已彻底移除
 * ========================================================================== */
line('\n=== 场景9 「动作切换」设置项已移除 ===');
{
  const api = makeCat().api;
  check(api.setSwitchSec === undefined, 'api 上不再有 setSwitchSec');
  check(api.getSwitchOptions === undefined, 'api 上不再有 getSwitchOptions');
  check(typeof api.getSwitchRange === 'function', '取而代之的是只读的 getSwitchRange()');
  check(!('switchSec' in api.getConfig()), 'getConfig() 不再暴露 switchSec');

  check(!html.includes('setCatSwitch'), '设置面板里不再有「动作切换」滑杆（setCatSwitch）');
  check(!html.includes('catSwitchOpts'), '设置面板里不再有 catSwitchOpts');
  check(!html.includes('双击召回原位'), '设置面板的提示文案已更新（不再写"双击召回原位"）');

  const saved = JSON.parse(makeCat().store['wtk-cat-config'] || '{}');
  check(!('switchSec' in saved) && !('v' in saved),
    `新存档不再写 switchSec / v：${JSON.stringify(saved)}`);

  // 老存档里残留这些字段时，仍要能正常载入（只是忽略掉）
  const legacy = makeCat({
    'wtk-cat-config': JSON.stringify({ on: true, w: 90, tripSec: 30, switchSec: 45, v: 1 })
  });
  const lc = legacy.api.getConfig();
  check(lc.w === 90 && lc.tripSec === 30,
    `老存档（含 switchSec/v）仍能正常载入：大小=${lc.w} 速度=${lc.tripSec} 开关=${lc.on}`);
}

/* ---------------- 汇总 ---------------- */
console.log(`\n全部场景跑完。RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
