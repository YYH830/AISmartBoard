/* eslint-disable */
/**
 * 猫猫动作轮换逻辑的无界面验证。
 * 做法：把 index.html 里那段 IIFE 原样抽出来，喂一套最小 DOM 桩，
 * 用假时钟推进时间，观察「动作切换是否按设定间隔发生」。
 * 每个场景都新建一个实例，避免上一个场景的状态（定时器、动作）漏进来干扰判断。
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const code = blocks.find((c) => c.includes('CAT_ACTIONS') && c.includes('catLayer'));
if (!code) { console.error('没找到猫猫脚本'); process.exit(1); }

/* 从源码里解析动作轮换顺序，让下面场景 4 / 场景 7 的期望值随动作表自动更新。
   这两处原先写死了动作个数（连点 4 次、期望 idle,walk,idle,walk…），
   每次往 ROTATION 里加动作都会让测试报"顺序不对"，其实逻辑是好的 ——
   属于测试自己过期了。改成从源码读，以后加动作就不必再动这个文件。 */
const ROTATION = (function () {
  const m = /var\s+ROTATION\s*=\s*\[([^\]]*)\]/.exec(code);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();
// 这里还早于 line() 的定义（它是 const，有 TDZ），所以先用 console.log 输出
console.log(`读到 ROTATION（${ROTATION.length} 个动作）: ${ROTATION.join(' → ')}`);

/** 造一只全新的猫（独立的时钟、定时器、localStorage）
 *  presetStore：可预置 localStorage 内容，用来模拟"用户之前存过的旧配置" */
function makeCat(presetStore) {
  let now = 0;
  const rafs = [];
  const timers = [];
  const store = Object.assign({}, presetStore);

  const makeEl = () => {
    const el = {
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
    };
    return el;
  };
  const layerEl = makeEl();

  const win = {
    addEventListener() {}, innerWidth: 1440, innerHeight: 900,
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
    setTimeout: (fn, ms) => { const t = { fn, at: now + (ms || 0) }; timers.push(t); return timers.length; },
    clearTimeout: () => {}
  };

  const fn = new Function('window', 'document', 'localStorage', 'performance',
    'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'console',
    `${code}\n;return window.cat;`);
  const api = fn(
    win,
    { readyState: 'complete', getElementById: (id) => (id === 'catLayer' ? layerEl : null), querySelector: () => null, createElement: makeEl, addEventListener() {} },
    { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    { now: () => now },
    win.requestAnimationFrame, win.setTimeout, win.clearTimeout,
    { log() {} }
  );

  return {
    api,
    /** 供测试模拟指针事件用的元素（就是那只猫） */
    el: layerEl.children[0],
    /** 模拟一次真实的鼠标单击（按下 → 松开，中间不移动） */
    click() {
      const el = this.el, h = el._h;
      const ev = { button: 0, pointerId: 1, clientX: 200, clientY: 300, preventDefault() {} };
      h.pointerdown(ev);
      // 按下到松开间隔 60ms
      for (let e = 0; e < 64; e += 16) {
        now += 16;
        for (const t of timers) if (!t.done && now >= t.at) { t.done = true; t.fn(); }
        const f = rafs.shift(); if (f) f(now);
      }
      h.pointerup({ type: 'pointerup', pointerId: 1, clientX: 200, clientY: 300 });
      // 等单击判定（230ms）
      for (let e = 0; e < 256; e += 16) {
        now += 16;
        for (const t of timers) if (!t.done && now >= t.at) { t.done = true; t.fn(); }
        const f = rafs.shift(); if (f) f(now);
      }
    },
    /** 模拟一次拖拽（按下 → 移动 → 松开） */
    drag(dx = 120) {
      const el = this.el, h = el._h;
      const ev = { button: 0, pointerId: 1, clientX: 200, clientY: 300, preventDefault() {} };
      h.pointerdown(ev);
      h.pointermove({ clientX: 200 + dx, clientY: 300 });
      now += 16;
      h.pointerup({ type: 'pointerup', pointerId: 1, clientX: 200 + dx, clientY: 300 });
      now += 16;
    },
    /** 模拟一次「快速单击」（按下→松开，且不越过双击判定窗口） */
    clickQuick() {
      const el = this.el, h = el._h;
      const ev = { button: 0, pointerId: 1, clientX: 200, clientY: 300, preventDefault() {} };
      h.pointerdown(ev);
      now += 16;
      h.pointerup({ type: 'pointerup', pointerId: 1, clientX: 200, clientY: 300 });
      now += 16;
    },
    /** 推进 ms 毫秒，每帧粒度 16ms */
    run(ms) {
      for (let e = 0; e < ms; e += 16) {
        now += 16;
        for (const t of timers) if (!t.done && now >= t.at) { t.done = true; t.fn(); }
        const f = rafs.shift();
        if (f) f(now);
      }
    },
    /** 记录动作变化时间线 */
    trace(ms) {
      const out = [];
      let last = api.state().action;
      out.push(`${(now / 1000).toFixed(1)}s:${last}`);
      for (let e = 0; e < ms; e += 16) {
        now += 16;
        for (const t of timers) if (!t.done && now >= t.at) { t.done = true; t.fn(); }
        const f = rafs.shift();
        if (f) f(now);
        const a = api.state().action;
        if (a !== last) { out.push(`${(now / 1000).toFixed(1)}s:${a}`); last = a; }
      }
      return out;
    }
  };
}

const line = (s) => console.log(s);

/* ---------------- 场景 1：默认 5 分钟 ---------------- */
line('=== 场景1 默认设置（动作切换 5 分钟），观察 22 分钟 ===');
{
  const c = makeCat();
  line('初始配置: ' + JSON.stringify(c.api.getConfig()));
  const tl = c.trace(1320000);
  line('动作时间线: ' + tl.join('  '));
  // 检查「待机」是否都被挤没了（跳过开头那次起步，它是特意留短的）
  const idleSpans = [];
  for (let i = 1; i < tl.length - 1; i++) {
    if (tl[i].includes(':idle')) {
      const a = parseFloat(tl[i]); const b = parseFloat(tl[i + 1]);
      idleSpans.push(+(b - a).toFixed(1));
    }
  }
  line(`每段待机时长（不含启动那次）: ${idleSpans.join('s, ')}s`);
  const allFiveMin = idleSpans.length > 0 && idleSpans.every((s) => Math.abs(s - 300) < 3);
  line(allFiveMin ? '✓ 每段待机都是 5 分钟（默认值生效）' : '✗ 待机时长与 5 分钟不符');
  const tooShort = idleSpans.filter((s) => s < 60).length;
  line(tooShort === 0 ? '✓ 没有"刚停下就又走"的情况' : `✗ 有 ${tooShort} 段待机短于一分钟`);
}

/* ---------------- 场景 1b：默认值迁移（老存档里的 30 秒） ---------------- */
line('\n=== 场景1b 默认值从 30 秒改为 5 分钟：老存档怎么处理 ===');
{
  // 情况一：老存档里是 30 秒、且没有版本号 —— 那是应用自己写的旧默认值，应升级为 5 分钟
  const old1 = { 'wtk-cat-config': JSON.stringify({ on: true, w: 72, tripSec: 60, switchSec: 30 }) };
  const c1 = makeCat(old1);
  const got1 = c1.api.getConfig().switchSec;
  line(`  老存档 {switchSec:30, 无版本号} → ${got1} 秒 ${got1 === 300 ? '✓ 已升级为 5 分钟' : '✗ 没升级'}`);

  // 情况二：老存档里是 30 秒，但已带版本号 —— 说明是用户自己选的，必须尊重
  const old2 = { 'wtk-cat-config': JSON.stringify({ on: true, w: 72, tripSec: 60, switchSec: 30, v: 1 }) };
  const c2 = makeCat(old2);
  const got2 = c2.api.getConfig().switchSec;
  line(`  老存档 {switchSec:30, v:1}      → ${got2} 秒 ${got2 === 30 ? '✓ 保留用户选择' : '✗ 误改了用户设置'}`);

  // 情况三：用户明确选了 10 分钟，不该被动
  const old3 = { 'wtk-cat-config': JSON.stringify({ on: true, w: 72, tripSec: 60, switchSec: 600 }) };
  const c3 = makeCat(old3);
  const got3 = c3.api.getConfig().switchSec;
  line(`  老存档 {switchSec:600, 无版本号} → ${got3} 秒 ${got3 === 600 ? '✓ 未被覆盖' : '✗ 被覆盖了'}`);

  // 情况四：完全没存过 —— 应用新默认值
  const c4 = makeCat();
  line(`  全新用户（无存档）              → ${c4.api.getConfig().switchSec} 秒 ${c4.api.getConfig().switchSec === 300 ? '✓ 新默认值' : '✗'}`);
}

/* ---------------- 场景 2：各档位都按设定节奏切换 ---------------- */
line('\n=== 场景2 切换间隔可调（各档位） ===');
{
  const opts = makeCat().api.getSwitchOptions();
  line('档位表: ' + opts.map((o) => `${o.label}(${o.sec}s)`).join('  '));
  line('');
  line('  判定方式：看每段「待机」持续多久 —— 它应当就等于设定的间隔');
  line('  （走路那段受屏幕宽度限制、最长约 1 分钟，不影响待机时长）');
  line('');
  for (const o of opts) {
    const c = makeCat();
    c.api.setSwitchSec(o.sec);
    const watch = o.sec === 0 ? 600000 : Math.max(4 * o.sec * 1000, 30000);
    const tl = c.trace(watch);

    if (o.sec === 0) {
      line(`  ${o.label.padStart(8)} → 观察 ${(watch / 60000).toFixed(1)} 分，动作变化 ${tl.length - 1} 次 ${tl.length === 1 ? '✓ 完全不动' : '✗ 还在自动切'}`);
      continue;
    }
    // 收集各段「待机」的时长（跳过启动那次特意留短的）
    const spans = [];
    for (let i = 1; i < tl.length - 1; i++) {
      if (tl[i].includes(':idle')) spans.push(parseFloat(tl[i + 1]) - parseFloat(tl[i]));
    }
    const ok = spans.length > 0 && spans.every((s) => Math.abs(s - o.sec) <= Math.max(0.5, o.sec * 0.02));
    line(`  ${o.label.padStart(8)} → 待机各段 ${spans.map((s) => s.toFixed(1) + 's').join(', ')} ${ok ? '✓ 与设定一致' : '✗ 与设定不符'}`);
  }

  const c = makeCat();
  c.api.setSwitchSec(300);                        // 5 分钟
  const tl = c.trace(1500000);                    // 25 分钟
  line('\n  5 分钟档的 25 分钟时间线: ' + tl.join('  '));
  const spans = [];
  for (let i = 1; i < tl.length - 1; i++) {
    const dur = (parseFloat(tl[i + 1]) - parseFloat(tl[i])) / 60;
    spans.push(`${tl[i].split(':')[1]} ${dur.toFixed(1)}分`);
  }
  line('  各动作持续: ' + spans.join(' | '));
}

/* ---------------- 场景 2b：档位吸附 + 旧配置迁移 ---------------- */
line('\n=== 场景2b 档位吸附（旧配置里的非档位值） ===');
{
  for (const raw of [45, 200, 1000, 100000, -5]) {
    const c = makeCat();
    c.api.setSwitchSec(raw);
    const got = c.api.getConfig().switchSec;
    const opts = c.api.getSwitchOptions().map((o) => o.sec);
    line(`  设 ${String(raw).padStart(7)} 秒 → 吸附为 ${String(got).padStart(5)} 秒 ${opts.includes(got) ? '✓' : '✗ 不是合法档位'}`);
  }
  // 模拟旧 localStorage：存着 45 秒
  const store = { 'wtk-cat-config': JSON.stringify({ on: true, w: 72, tripSec: 60, switchSec: 45 }) };
  const c2 = makeCat(store);
  line(`  旧配置 switchSec=45 载入后 → ${c2.api.getConfig().switchSec} 秒`);
}

/* ---------------- 场景 3：不自动切换 ---------------- */
line('\n=== 场景3 设为「不自动切换」(0) ===');
{
  const c = makeCat();
  c.api.setSwitchSec(0);
  const tl = c.trace(120000);
  line(`120 秒内动作变化: ${tl.join('  ')}  ${tl.length === 1 ? '（只有初始那一次，符合预期）' : '（出现了自动切换，不符合预期）'}`);
}

/* ---------------- 场景 4：手动切换 ---------------- */
line('\n=== 场景4 手动切换（等同单击猫猫 / cat.next()） ===');
{
  const c = makeCat();
  const seq = [c.api.state().action];
  for (let i = 0; i < 5; i++) seq.push(c.api.next());
  line('连续切 5 次: ' + seq.join(' -> '));
  // 期望值取自源码里的 ROTATION（初始在 ROTATION[0]，之后依次往后走）
  const expect = ROTATION.slice(0, 6);
  line(seq.join(',') === expect.join(',')
    ? `✓ 按 ROTATION 顺序循环（${expect.join(' -> ')}）`
    : `✗ 顺序不对，期望 ${expect.join(',')}`);
}

/* ---------------- 场景 5：手动切换会重新计时 ---------------- */
line('\n=== 场景5 手动切换后重新计时（不会刚点完又被自动切走） ===');
{
  const c = makeCat();
  c.api.setSwitchSec(30);
  c.run(1000);
  c.api.next();                                  // 用户点了一下
  const st = c.api.state();
  line(`点完立刻查看：动作=${st.action}，距下次自动切换 ${Math.round(st.nextSwitchInMs / 1000)} 秒`);
  line(st.nextSwitchInMs > 25000 ? '✓ 已重新计满 30 秒' : '✗ 计时没重置，可能刚点完就被自动切走');
}

/* ---------------- 场景 6：一个完整周期 ---------------- */
line('\n=== 场景6 切换间隔 10 秒：看完整周期（走一段 / 站一段 是否时长相当） ===');
{
  const c = makeCat();
  c.api.setSwitchSec(10);
  const tl = c.trace(60000);
  line('60 秒时间线: ' + tl.join('  '));
  const spans = [];
  for (let i = 0; i < tl.length - 1; i++) {
    spans.push(`${tl[i].split(':')[1]} ${(parseFloat(tl[i + 1]) - parseFloat(tl[i])).toFixed(1)}s`);
  }
  line('各动作持续: ' + spans.join(' | '));
}

line('\n全部场景跑完，未抛异常。');

/* ---------------- 场景 7：真实鼠标单击（回归：点了却总是切回走路） ---------------- */
line('\n=== 场景7 模拟真实鼠标单击（回归验证） ===');
{
  const c = makeCat();
  c.api.setSwitchSec(0);                     // 关掉自动切换，避免干扰判断
  // 先把动作往前推一格，确保不是初始态
  c.api.next();
  const before = c.api.state().action;
  line(`点之前：动作=${before}`);
  c.click();
  const after = c.api.state().action;
  // 期望：单击应把轮换推进一格；不能"点了却切回走路"
  // （老 bug：walk 在窄屏退化成 idle，下一位又从 idle 反推，于是 idle↔walk 死循环）
  const iB = ROTATION.indexOf(before);
  const expect = iB >= 0 ? ROTATION[(iB + 1) % ROTATION.length] : null;
  line(`点一下 → 动作=${after}  ${after === expect ? `✓ 推进到下一个（${before} → ${after}）` : `✗ 期望 ${expect}，实际 ${after}`}`);
  line(after !== before ? '✓ 动作确实变了（没有卡在原地）' : '✗ 点了没反应');

  // 连点「动作个数」次应回到原点（个数从 ROTATION 读，加动作后不必改这里）
  c.api.setSwitchSec(0);
  const n = ROTATION.length || 4;
  const seen = [c.api.state().action];
  for (let i = 0; i < n; i++) { c.click(); seen.push(c.api.state().action); }
  line(`连点 ${n} 次: ` + seen.join(' -> '));
  line(seen[0] === seen[n]
    ? `✓ 单击切换是成对循环的（${n} 次一轮回到起点）`
    : '✗ 循环不对称（说明按下时把动作改掉了）');
}

/* ---------------- 场景 8：单击不会让猫莫名挪窝 ---------------- */
line('\n=== 场景8 单击不该把猫"挪走" ===');
{
  let moved = 0;
  for (let i = 0; i < 20; i++) {
    const c = makeCat();
    c.api.setSwitchSec(0);
    const before = c.api.where();
    c.api.next();                            // 确保在待机
    c.click();                               // 点到待机
    const after = c.api.where();
    if (Math.abs(after.x - before.x) > 60 || Math.abs(after.y - before.y) > 40) moved++;
  }
  line(`20 次单击里发生明显位移 ${moved} 次 ${moved === 0 ? '✓ 一次都没有' : '✗ 仍在随机挪窝'}`);
}

/* ---------------- 场景 9：拖拽仍然正常 ---------------- */
line('\n=== 场景9 拖拽功能没被破坏 ===');
{
  const c = makeCat();
  const before = c.api.where();
  c.drag(150);
  const after = c.api.where();
  line(`拖动前 x=${before.x} → 拖动后 x=${after.x} ${Math.abs(after.x - before.x) > 100 ? '✓ 跟着走了' : '✗ 没拖动'}`);
  line(`拖完动作=${c.api.state().action} ${c.api.state().action === 'idle' ? '✓ 站姿' : '✗ 不是站姿'}`);
  line(`是否还在拖拽中=${c.api.state().dragging} ${c.api.state().dragging === false ? '✓ 已结束' : '✗ 卡住了'}`);
}

/* ---------------- 场景 10：双击仍然回位 ---------------- */
line('\n=== 场景10 快速双击 = 回位（别被"换动作"吃掉） ===');
{
  const c = makeCat();
  c.api.setSwitchSec(0);
  const home = c.api.home();
  c.drag(200);                                     // 先拖到别处
  const away = c.api.where();
  line(`出生点 x=${home.x} → 拖到 x=${away.x}`);
  c.clickQuick();                                  // 第一下
  c.clickQuick();                                  // 第二下（在 230ms 窗口内）
  c.run(300);                                      // 让判定落地
  const back = c.api.where();
  line(`双击后 x=${back.x} y=${back.y} ${Math.abs(back.x - home.x) < 10 ? '✓ 回到出生点了' : '✗ 没回去'}`);
}
