#!/usr/bin/env node
/**
 * AI智能看板 —— 本地数据服务（跨平台：Windows / macOS / Linux）
 *
 * 特点：
 *   1. 只用 Node.js 内置模块，无需 npm install，双击启动脚本即可运行；
 *   2. 仅监听 127.0.0.1（本机），不对外暴露；
 *   3. 支持多个台账文件：/api/files 列出目录里所有 .md，/api/data?file=xx.md 读写指定文件；
 *   4. 写入采用「临时文件 + 重命名」，避免界面读到半截内容；
 *   5. 删除台账时移入 .trash 目录而不是彻底删除，误删可找回。
 *
 * 用法：
 *   node server.js                 启动并自动打开浏览器（默认端口 8765）
 *   node server.js --app           以「应用模式窗口」打开（无地址栏，像原生软件，需 Chrome/Edge）
 *   node server.js --port=9000      指定端口
 *   node server.js --no-open        不自动打开浏览器（后台运行用）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

/* ------------------------------ 基本配置 ------------------------------ */

/*
 * 目录结构约定：
 *   项目根/
 *   ├── launchers/                   启动脚本（Windows / macOS 本机用）
 *   ├── README.txt                  使用说明
 *   ├── DEPLOY.txt                  服务器部署说明
 *   ├── data/                       ← 所有 .md 台账文件（用户数据）
 *   └── app/                        ← 本脚本与 index.html 所在位置
 */
const APP_DIR = __dirname;                                          // 程序目录（提供 index.html 等静态文件）
const PROJECT_ROOT = path.resolve(__dirname, '..');                  // 项目根目录（启动脚本所在位置）
const DATA_ROOT = path.join(PROJECT_ROOT, 'data');                   // 数据根目录：每个账号一个子目录

const DEFAULT_FILE = 'tasks.md';                                     // 默认台账文件名
const PORT_FILE = path.join(APP_DIR, '.server-port');                // 记录实际监听端口（Mac 启动脚本据此打开正确地址）
const NON_LEDGER_MD = ['readme.md'];                                 // 这些 .md 是文档而非台账，不列进侧边栏
const STATIC_BLOCKED = ['server.js', 'server.ps1', 'package.json'];   // 程序源码不通过静态通道对外提供
const APP_TAG = 'wtk';                                               // 服务身份标记，界面据此确认"这是本工具的服务"
const MAX_PORT_TRY = 40;                                             // 端口被占用时最多往后试多少个

/* ------------------------------ 部署配置（环境变量优先） ------------------------------ */

/*
 * 两种使用方式：
 *   1. 本机使用：什么都不用配，默认只监听 127.0.0.1，除自己外谁都访问不到。
 *   2. 服务器部署：必须用环境变量指定监听地址和登录账号密码，例如
 *        WTK_HOST=0.0.0.0 WTK_PORT=8765 WTK_USER=admin WTK_PASS=你的密码 node app/server.js
 *
 * 环境变量一览：
 *   WTK_HOST  监听地址。默认 127.0.0.1（仅本机）；服务器部署用 0.0.0.0
 *   WTK_PORT  监听端口。默认 8765；被占用时自动往后顺延
 *   WTK_USER  登录账号。默认 admin
 *   WTK_PASS  登录密码。服务器部署必填，详见下面的「访问保护」说明
 *   WTK_NO_AUTH=1  显式关闭访问保护。危险，只在你确信网络环境安全时使用
 */
/**
 * 读取项目根目录的 .env 配置文件（每行一条 KEY=VALUE，支持 # 注释）
 * 已存在的环境变量优先，所以命令行 / 面板里设置的值不会被文件覆盖
 */
function loadEnvFile() {
  const candidates = [path.join(PROJECT_ROOT, '.env'), path.join(APP_DIR, '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    text.split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s || s.charAt(0) === '#') return;
      const i = s.indexOf('=');
      if (i < 0) return;
      const key = s.slice(0, i).trim();
      let val = s.slice(i + 1).trim();
      // 去掉包裹的引号，方便写含空格或特殊字符的值
      const q = val.charAt(0);
      if (val.length > 1 && (q === '"' || q === "'") && val.charAt(val.length - 1) === q) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    });
    break;                                 // 只认第一个找到的配置文件
  }
}
loadEnvFile();

let host = process.env.WTK_HOST || '127.0.0.1';
let username = (process.env.WTK_USER || 'admin').trim() || 'admin';
let accessPassword = (process.env.WTK_PASS || '').trim();
const noAuth = process.env.WTK_NO_AUTH === '1';

// 命令行参数（优先级高于环境变量）
let port = parseInt(process.env.WTK_PORT, 10) || 8765;
let autoOpen = true;
let appMode = false;
let restartWait = false;      // 由「重启服务」拉起的子进程为 true：等旧进程释放端口，不另换端口
process.argv.slice(2).forEach((arg) => {
  const m = arg.match(/^--port=(\d{1,5})$/);
  if (m) port = parseInt(m[1], 10);
  const h = arg.match(/^--host=(.+)$/);
  if (h) host = h[1];
  if (arg === '--no-open') autoOpen = false;
  if (arg === '--app') appMode = true;
  if (arg === '--restart-wait') restartWait = true;
});

/*
 * 访问保护判定
 * 注意：必须放在命令行参数解析之后 —— --host 也可能把服务暴露到公网，
 *      若在此之前判断，用 --host=0.0.0.0 启动就会漏掉自动生成密码这一步。
 */

// 对外服务（不是仅本机）却没设密码：自动生成一个，避免数据在公网上裸奔
let generatedPassword = '';
if (host !== '127.0.0.1' && host !== 'localhost' && !accessPassword && !noAuth) {
  generatedPassword = crypto.randomBytes(9).toString('base64url');
  accessPassword = generatedPassword;
}

/*
 * 账号表：主账号来自 .env（WTK_USER / WTK_PASS）。
 * 以后要开放给其他人用，把额外账号写进项目根目录的 .users.json：
 *     [{ "user": "张三", "pass": "一个密码" }, ...]
 * 每个账号各自保存自己的 AI 设置（模型 / Key），互不干扰。
 */
const ACCOUNTS_FILE = path.join(PROJECT_ROOT, '.users.json');
function loadExtraUsers() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.users) ? j.users : []);
    return arr
      .filter((u) => u && typeof u.user === 'string' && typeof u.pass === 'string' && u.user.trim() && u.pass)
      .map((u) => ({ user: u.user.trim(), pass: u.pass }));
  } catch (e) { return []; }
}
const USERS = [];
(function buildUserList() {
  const seen = {};
  if (accessPassword) { USERS.push({ user: username, pass: accessPassword }); seen[username] = 1; }
  loadExtraUsers().forEach((u) => { if (!seen[u.user]) { USERS.push(u); seen[u.user] = 1; } });
})();

/* ------------------------------ 团队看板（多人协同） ------------------------------
 * 一个团队看板 = 一个独立工作区：data/_teams/<团队ID>/
 *     tasks.md      共享任务台账（所有成员可读写）
 *     team.json     团队信息 { id, name, owner, members:[{user,pass,name}] }
 *     操作历史.md     审计日志
 *     .ai-chat/     各成员的 AI 聊天历史
 * 归属：主账号（.env / .users.json）是 owner；owner 创建的成员账号是 member、绑定到该团队。
 * 团队成员账号动态生效（改动后无需重启）。
 */
const TEAMS_ROOT = path.join(DATA_ROOT, '_teams');
function safeTeamId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40); }
function teamDir(id) { return path.join(TEAMS_ROOT, safeTeamId(id)); }
function loadTeam(id) { try { return JSON.parse(fs.readFileSync(path.join(teamDir(id), 'team.json'), 'utf8')); } catch (e) { return null; } }
function listTeams() { try { return fs.readdirSync(TEAMS_ROOT).map((d) => loadTeam(d)).filter(Boolean); } catch (e) { return []; } }
function saveTeam(t) { fs.mkdirSync(teamDir(t.id), { recursive: true }); fs.writeFileSync(path.join(teamDir(t.id), 'team.json'), JSON.stringify(t, null, 2), { encoding: 'utf8', mode: 0o600 }); }
function teamsOfOwner(user) { return listTeams().filter((t) => t.owner === user); }
/* ---------- 成员池：一个账号 = 一个人，可加入多个团队 ---------- */
const MEMBERS_FILE = path.join(DATA_ROOT, '_members.json');
function loadMemberPool() {
  try { const j = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); return Array.isArray(j) ? j : (j && Array.isArray(j.members) ? j.members : []); } catch (e) { return []; }
}
function saveMemberPool(arr) {
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); fs.writeFileSync(MEMBERS_FILE, JSON.stringify(arr, null, 2), { encoding: 'utf8', mode: 0o600 }); } catch (e) { /* 忽略 */ }
}
function findPoolMember(user) { return loadMemberPool().filter((m) => m.user === user)[0] || null; }
function nameOfMember(user) { const m = findPoolMember(user); return m ? (m.name || m.user) : user; }
/** 团队成员用户名列表（兼容旧的 {user,pass,name} 写法） */
function teamMemberUsers(t) { return (t.members || []).map((m) => (typeof m === 'string' ? m : (m && m.user))).filter(Boolean); }
function teamsOfMember(user) { return listTeams().filter((t) => teamMemberUsers(t).indexOf(user) >= 0); }

/** 所有可用账号：主账号（owner）+ 成员池里的成员账号 */
function allAccounts() {
  const list = USERS.map((u) => ({ user: u.user, pass: u.pass, role: 'owner' }));
  loadMemberPool().forEach((m) => list.push({ user: m.user, pass: m.pass, role: 'member' }));
  return list;
}

/* ------------------------------ 操作历史（审计） ------------------------------ */

/** 从台账文本里抽取「任务池」表格的行，返回 { 编号: {title,status,days,assignee,note} } */
function parseTaskRows(text) {
  const rows = {};
  const lines = String(text || '').split(/\r?\n/);
  let inPool = false, header = null;
  for (const line of lines) {
    const s = line.trim();
    if (/^#{1,6}\s/.test(s)) { inPool = /任务池/.test(s); header = null; continue; }
    if (!inPool || s.charAt(0) !== '|') continue;
    const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;      // 分隔行
    if (/^编号$/.test(cells[0] || '')) { header = cells; continue; }
    if (!header) continue;
    const idx = (re) => header.findIndex((h) => re.test(h));
    const iId = idx(/编号|^id$/i), iT = idx(/任务|名称|标题/), iS = idx(/状态|进度/),
          iD = idx(/人天|天数|工作量|预估/), iA = idx(/负责人|成员|指派|责任人|执行人/), iN = idx(/备注|说明|描述/);
    const id = (iId >= 0 ? cells[iId] : cells[0]) || '';
    if (!id) continue;
    rows[id] = {
      title: iT >= 0 ? (cells[iT] || '') : '',
      status: iS >= 0 ? (cells[iS] || '') : '',
      days: iD >= 0 ? (cells[iD] || '') : '',
      assignee: iA >= 0 ? (cells[iA] || '') : '',
      note: iN >= 0 ? (cells[iN] || '') : ''
    };
  }
  return rows;
}

/** 比对两次台账内容，得出任务级的增 / 改 / 删 */
function diffTasks(oldText, newText) {
  const a = parseTaskRows(oldText), b = parseTaskRows(newText), out = [];
  Object.keys(b).forEach((id) => {
    if (!a[id]) { out.push({ act: '新增任务', target: id + ' ' + b[id].title }); return; }
    const o = a[id], n = b[id], ch = [];
    if (o.title !== n.title) ch.push('任务名「' + o.title + '」→「' + n.title + '」');
    if (o.status !== n.status) ch.push('状态 ' + (o.status || '—') + '→' + (n.status || '—'));
    if (o.days !== n.days) ch.push('人天 ' + (o.days || '—') + '→' + (n.days || '—'));
    if (o.assignee !== n.assignee) ch.push('负责人 ' + (o.assignee || '无') + '→' + (n.assignee || '无'));
    if (o.note !== n.note) ch.push('备注修改');
    if (ch.length) out.push({ act: '修改任务', target: id + ' ' + n.title + '（' + ch.join('；') + '）' });
  });
  Object.keys(a).forEach((id) => { if (!b[id]) out.push({ act: '删除任务', target: id + ' ' + a[id].title }); });
  return out;
}

function appendAudit(dir, user, entries) {
  if (!entries || !entries.length) return;
  const f = path.join(dir, '操作历史.md');
  const head = fs.existsSync(f) ? '' : '# 操作历史\n\n> 记录团队成员对看板的增删改，用于追溯“谁在什么时候改了什么”。\n';
  const stamp = nowStamp();
  const lines = entries.map((e) => '- ' + stamp + ' · ' + user + ' · ' + e.act + ' · ' + String(e.target || '').replace(/\n/g, ' ')).join('\n');
  try { fs.appendFileSync(f, head + lines + '\n', 'utf8'); } catch (e) { /* 忽略 */ }
}

function readAudit(dir) {
  try {
    return fs.readFileSync(path.join(dir, '操作历史.md'), 'utf8').split(/\r?\n/)
      .filter((l) => l.charAt(0) === '-' && l.charAt(1) === ' ')
      .map((l) => { const p = l.slice(2).split(' · '); return { time: p[0] || '', user: p[1] || '', act: p[2] || '', target: p.slice(3).join(' · ') }; })
      .reverse();
  } catch (e) { return []; }
}

// 访问保护是否生效
const authOn = !noAuth && !!accessPassword;

// 本次服务进程的启动信息，界面上的「服务状态」面板会显示
const SERVER_STARTED_AT = Date.now();
let currentPort = port;       // 实际监听到的端口（被占用时会顺延，以这个为准）
let lastTouchedFile = '';     // 最近被界面读写的台账，用于状态面板显示

/** 状态面板显示用的「当前台账」；服务端不存界面状态，用最近访问过的文件近似表示 */
function currentFile() {
  return lastTouchedFile || DEFAULT_FILE;
}

// 新建台账时使用的空白模板
const TEMPLATE = [
  '# AI智能看板',
  '',
  '> 本文件由「AI智能看板」自动读写，可手工编辑；保存后看板会自动刷新。',
  '',
  '## 一、任务池',
  '',
  '| 编号 | 任务 | 状态 | 预估人天 | 备注 |',
  '| :--- | :--- | :--- | ---: | :--- |',
  '',
  '## 二、排期',
  '',
  '| 编号 | 开始 | 结束 |',
  '| :--- | :--- | :--- |',
  ''
].join('\n');

// 数据根目录不存在则创建（各账号的子目录在首次访问时创建）
if (!fs.existsSync(DATA_ROOT)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

/* ------------------------------ 台账文件管理 ------------------------------ */

/**
 * 校验台账文件名：只允许「data 目录下的单层 .md 文件」
 * 目的：防止通过 ../ 或绝对路径读到「data」目录之外的文件
 * @returns {string|null} 合法则返回去掉首尾空白的文件名，否则返回 null
 */
function safeMdName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length > 120) return null;
  if (n.startsWith('.')) return null;                        // 不处理隐藏文件
  if (n.indexOf('/') >= 0 || n.indexOf('\\') >= 0) return null; // 不允许子目录
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) return null;        // Windows 非法字符
  if (!/\.md$/i.test(n)) return null;                       // 必须是 .md
  return n;
}

/* --------- 多账号数据隔离：每个账号一个数据目录 data/<账号>/ ---------- */

/** 账号名安全化（同时用作磁盘目录名） */
function safeUserName(user) {
  return String(user || 'local').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 60) || 'local';
}

/** 某账号的台账数据目录 */
function ledgerDir(user) {
  return path.join(DATA_ROOT, safeUserName(user));
}

/** 确保某账号的数据目录存在；若一本台账都没有，就给一个默认的 tasks.md */
function ensureLedgerDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let has = false;
    try {
      has = fs.readdirSync(dir).some((f) => safeMdName(f) !== null && NON_LEDGER_MD.indexOf(f.toLowerCase()) < 0);
    } catch (e) { has = false; }
    if (!has && !fs.existsSync(path.join(dir, DEFAULT_FILE))) {
      fs.writeFileSync(path.join(dir, DEFAULT_FILE), TEMPLATE, 'utf8');
    }
  } catch (e) { /* 忽略 */ }
}

/** 台账文件的完整路径（限定在账号自己的目录内） */
function ledgerPath(dir, name) {
  return path.join(dir, name);
}

/** 取某个文件的修改时间（毫秒时间戳），界面用它判断是否被外部改动 */
function getMTime(dir, name) {
  try {
    return Math.floor(fs.statSync(ledgerPath(dir, name)).mtimeMs);
  } catch (e) {
    return 0;
  }
}

/** 读取台账内容；文件不存在或读失败时返回空字符串 */
function readData(dir, name) {
  try {
    return fs.readFileSync(ledgerPath(dir, name), 'utf8');
  } catch (e) {
    return '';
  }
}

/** 原子写入：先写临时文件再改名，避免界面读到写了一半的内容 */
function writeData(dir, name, text) {
  const target = ledgerPath(dir, name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * 粗略统计台账里的任务条数（供侧边栏预览用，不追求绝对精确）
 * 只统计「## 一、任务池」小节表格中的数据行
 */
function countTasks(dir, name) {
  try {
    const lines = fs.readFileSync(ledgerPath(dir, name), 'utf8').split(/\r?\n/);
    let inPool = false;
    let n = 0;
    for (const line of lines) {
      const s = line.trim();
      if (/^#{1,6}\s/.test(s)) {          // 遇到标题：判断是否进入任务池小节
        inPool = /任务池/.test(s);
        continue;
      }
      if (!inPool || !s.startsWith('|')) continue;
      if (/^\|[\s:|-]+\|$/.test(s)) continue;   // 表头分隔行 | :--- | :--- |
      if (/编号/.test(s)) continue;             // 表头行
      n++;
    }
    return n;
  } catch (e) {
    return 0;
  }
}

/** 列出「data」文件夹里所有台账文件（最近的排前面） */
function listFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) =>
      safeMdName(f) !== null && NON_LEDGER_MD.indexOf(f.toLowerCase()) < 0);
  } catch (e) {
    return [];
  }
  const files = names.map((name) => {
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(ledgerPath(dir, name));
      size = st.size;
      mtime = Math.floor(st.mtimeMs);
    } catch (e) { /* 文件可能刚被删除 */ }
    return { name, size, mtime, tasks: countTasks(dir, name) };
  });
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

/** 把用户输入的名字规范成 xxx.md（允许只输入"生活"） */
function normalizeNewName(raw) {
  let n = typeof raw === 'string' ? raw.trim() : '';
  if (!n) return null;
  if (!/\.md$/i.test(n)) n += '.md';
  return safeMdName(n);
}

/** 删除台账：移入账号目录下的「.trash」而不是彻底删除，避免误删 */
function trashFile(dir, name) {
  const tr = path.join(dir, '.trash');
  if (!fs.existsSync(tr)) fs.mkdirSync(tr, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(tr, stamp + '_' + name);
  fs.renameSync(ledgerPath(dir, name), dest);
  return dest;
}

/**
 * 兼容旧目录结构：把「项目根目录的 .md」和「data/ 根目录下的 .md」
 * 统一搬进主账号的数据目录 data/<主账号>/；只在目标不存在时移动。
 */
function migrateLegacyLedgers() {
  const primary = ledgerDir(username);
  const moveInto = (from, name) => {
    try {
      const to = path.join(primary, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) return;
      fs.mkdirSync(primary, { recursive: true });
      fs.renameSync(from, to);
      console.log('  已迁移台账：' + name);
    } catch (e) { /* 忽略 */ }
  };
  try {
    fs.readdirSync(PROJECT_ROOT)
      .filter((f) => safeMdName(f) !== null && NON_LEDGER_MD.indexOf(f.toLowerCase()) < 0)
      .forEach((f) => moveInto(path.join(PROJECT_ROOT, f), f));
  } catch (e) { /* 忽略 */ }
  try {
    fs.readdirSync(DATA_ROOT)
      .filter((f) => safeMdName(f) !== null && NON_LEDGER_MD.indexOf(f.toLowerCase()) < 0)
      .forEach((f) => moveInto(path.join(DATA_ROOT, f), f));
    const oldChat = path.join(DATA_ROOT, '.ai-chat');
    const newChat = path.join(primary, '.ai-chat');
    if (fs.existsSync(oldChat) && !fs.existsSync(newChat)) {
      fs.mkdirSync(primary, { recursive: true });
      fs.renameSync(oldChat, newChat);
    }
  } catch (e) { /* 忽略 */ }
}

// 首次运行准备：迁移旧数据、确保主账号目录与默认台账存在
migrateLegacyLedgers();
ensureLedgerDir(ledgerDir(username));

// 迁移：把旧团队里内嵌的成员账号({user,pass,name})抽到全局成员池，团队改为引用用户名
(function migrateMemberPool() {
  try {
    const pool = loadMemberPool();
    const seen = {}; pool.forEach((m) => { seen[m.user] = 1; });
    let poolChanged = false;
    listTeams().forEach((t) => {
      const raw = t.members || [];
      let teamChanged = false;
      const users = [];
      raw.forEach((m) => {
        if (typeof m === 'string') { users.push(m); return; }
        if (m && m.user) {
          users.push(m.user);
          if (m.pass && !seen[m.user]) { pool.push({ user: m.user, pass: m.pass, name: m.name || m.user }); seen[m.user] = 1; poolChanged = true; }
        }
        teamChanged = true;
      });
      if (teamChanged) { t.members = users; saveTeam(t); }
    });
    if (poolChanged) saveMemberPool(pool);
  } catch (e) { /* 迁移失败不影响启动 */ }
})();

/* ------------------------------ HTTP 工具 ------------------------------ */

/** 发送 JSON 响应（JSON.stringify 会正确转义中文与换行） */
function sendJson(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 发送纯文本响应 */
function sendText(res, text, code) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

/* ------------------------------ 访问保护（服务器部署时生效） ------------------------------ */

const COOKIE_NAME = 'wtk_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;      // 登录状态保持 30 天
const LOGIN_FILE = path.join(APP_DIR, 'login.html');

/** 由「账号 + 密码」派生出登录令牌；两者不变则令牌不变，重启服务后无需重新登录 */
function authTokenFor(u, p) {
  return crypto.createHash('sha256')
    .update('wtk-ledger::' + u + '::' + p)
    .digest('hex');
}

/** 判定是否是"一眼就能猜到"的弱口令，用于启动时给出风险提示 */
const WEAK_PASSWORDS = ['12345', '123456', '12345678', 'password', 'admin',
  '1234', 'admin123', '000000', '111111', 'abc123', 'qwerty'];
function isWeakPassword(pw) {
  if (!pw) return false;
  if (WEAK_PASSWORDS.indexOf(pw.toLowerCase()) >= 0) return true;
  return pw.length < 8;                 // 太短也算弱
}

/** 解析请求里的 Cookie */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (e) {
      out[k] = part.slice(i + 1).trim();
    }
  });
  return out;
}

/** 定长比较，避免通过响应耗时逐位猜出密码 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  try {
    return crypto.timingSafeEqual(x, y);
  } catch (e) {
    return false;
  }
}

/** 找到本次请求对应的账号条目（未登录返回 null） */
function authedEntry(req) {
  if (!authOn) return { user: (USERS[0] && USERS[0].user) || 'local', pass: '', role: 'owner' };
  const got = parseCookies(req)[COOKIE_NAME];
  if (!got) return null;
  for (const u of allAccounts()) {
    if (safeEqual(got, authTokenFor(u.user, u.pass))) return u;
  }
  return null;
}

/** 当前登录的账号名（未登录返回空串） */
function authedUser(req) {
  const e = authedEntry(req);
  return e ? e.user : '';
}

/**
 * 解析本次请求要访问的「看板」并做权限校验（无权限返回 null）。
 *   teamId 非空 -> 团队看板（成员只能进自己所属的团队；只有 owner 能访问自己的团队）
 *   teamId 为空 -> 个人看板（owner 自己的数据目录）
 */
function resolveBoard(req, teamId, file) {
  const me = authedEntry(req);
  if (!me) return null;
  if (me.role === 'member') {
    const teams = teamsOfMember(me.user);
    if (!teams.length) return null;
    let t = null;
    if (teamId) { t = teams.filter((x) => x.id === teamId)[0] || null; if (!t) return null; }   // 越权访问别的团队
    else t = teams[0];
    return { user: me.user, role: 'member', team: t, dir: teamDir(t.id), file: DEFAULT_FILE };
  }
  if (teamId) {
    const t = loadTeam(safeTeamId(teamId));
    if (!t || t.owner !== me.user) return null;           // 只能访问自己创建的团队
    return { user: me.user, role: 'owner', team: t, dir: teamDir(t.id), file: DEFAULT_FILE };
  }
  return { user: me.user, role: 'owner', team: null, dir: ledgerDir(me.user), file: safeMdName(file) || DEFAULT_FILE };
}

/** 本次请求是否已通过密码验证 */
function isAuthed(req) {
  if (!authOn) return true;                       // 未启用访问保护
  return !!authedEntry(req);
}

/** 登录成功：下发登录 Cookie（HttpOnly，脚本读不到，降低被窃取的风险） */
function setAuthCookie(res, u, p) {
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + authTokenFor(u, p) + '; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; HttpOnly; SameSite=Lax');
}

/** 退出登录：清除 Cookie */
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
}

/** 返回登录页；文件读不到时退回一段内置的最简页面 */
function sendLoginPage(res) {
  let html = '';
  try {
    html = fs.readFileSync(LOGIN_FILE, 'utf8');
  } catch (e) {
    html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
           '<title>需要登录</title></head><body style="font-family:sans-serif;padding:40px">' +
           '<h2>需要登录</h2><p>请通过 /api/login 提交访问密码后再访问。</p></body></html>';
  }
  const body = Buffer.from(html, 'utf8');
  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'WWW-Authenticate': 'Cookie'
  });
  res.end(body);
}

/** 扩展名 -> Content-Type */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8'
};

/** 读取本次请求的完整请求体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 解析 JSON 请求体，失败返回 null */
async function readJson(req) {
  try {
    const text = await readBody(req);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    return null;
  }
}

/** 用系统默认浏览器打开地址（三个平台各自的命令） */
function openBrowser(url) {
  if (process.platform === 'win32') exec('start "" "' + url + '"', { shell: 'cmd.exe', windowsHide: true }, () => {});
  else if (process.platform === 'darwin') exec('open "' + url + '"', () => {});
  else exec('xdg-open "' + url + '"', () => {});
}

/** 在常见安装位置寻找 Chrome / Edge / Brave 等 Chromium 内核浏览器 */
function findChromium() {
  const win = [
    (process.env['ProgramFiles'] || 'C:\\Program Files') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['LocalAppData'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') + '\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env['ProgramFiles'] || 'C:\\Program Files') + '\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env['LocalAppData'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env['ProgramFiles'] || 'C:\\Program Files') + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
  ];
  const mac = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    (process.env.HOME || '') + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  const linux = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'
  ];
  const list = process.platform === 'win32' ? win : (process.platform === 'darwin' ? mac : linux);
  for (const exe of list) {
    if (!exe) continue;
    try { if (fs.existsSync(exe)) return exe; } catch (e) { /* 忽略 */ }
  }
  return null;
}

/** 打开界面：应用模式（无地址栏）或普通浏览器标签页 */
function openUI(url) {
  if (!appMode) { openBrowser(url); return; }
  const exe = findChromium();
  if (!exe) {
    console.log('  未找到 Chrome / Edge，改用系统默认浏览器打开（普通标签页）。');
    openBrowser(url);
    return;
  }
  try {
    // 独立进程启动，服务退出后窗口仍可继续使用
    const child = spawn(exe, ['--app=' + url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    openBrowser(url);
  }
}

/* ------------------------------ AI 对话（DeepSeek 等） ------------------------------ */

/*
 * 设计说明：
 *   · 模型调用全部由服务端发起，API Key 只存在服务器上（.ai-config.json，权限 600），
 *     不落到浏览器，也顺手绕过跨域；
 *   · 底层走 OpenAI 兼容协议（/chat/completions），所以 DeepSeek 之外，
 *     OpenAI / 通义 / Moonshot / 本地 Ollama 等只要是兼容协议都能直接用；
 *   · 想加新服务商，只要往 AI_PROVIDERS 里补一条预设即可（label + baseUrl + models）。
 */
const AI_CONFIG_FILE = path.join(PROJECT_ROOT, '.ai-config.json');

const AI_PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro-0813'] },
  custom:   { label: '自定义（OpenAI 兼容）', baseUrl: '', models: [] }
};

const AI_DEFAULT = { provider: 'deepseek', baseUrl: AI_PROVIDERS.deepseek.baseUrl, model: 'DeepSeek-V4.1-Flash', apiKey: '' };

/**
 * 模型展示名 / 旧模型名 → DeepSeek 实际 API 模型 ID。
 * 看板下拉里显示的是「DeepSeek-V4.1-Flash / DeepSeek-V4-Pro-0813」，
 * 真正调用接口时转成 deepseek-flash / deepseek-v4-pro。
 */
const MODEL_ALIAS = {
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek v4.1 flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  'deepseek v4 pro 0813': 'deepseek-v4-pro'
};
function normalizeModel(m) {
  const s = String(m == null ? '' : m).trim();
  return MODEL_ALIAS[s.toLowerCase()] || s;
}

/**
 * AI 设置按「账号」分别保存：{ users: { "账号名": { provider, baseUrl, model, apiKey } } }
 * （旧版单账号格式 { provider,... } 会自动迁移到主账号名下）
 */
function loadAiStore() {
  let data = {};
  try {
    const j = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
    if (j && typeof j === 'object') data = j;
  } catch (e) { /* 没配置过 */ }
  if (!data.users || typeof data.users !== 'object') {
    const legacy = (data.provider || data.apiKey || data.model || data.baseUrl) ? data : null;
    data = { users: {} };
    if (legacy) {
      data.users[username] = { provider: legacy.provider, baseUrl: legacy.baseUrl, model: legacy.model, apiKey: legacy.apiKey };
    }
  }
  return data;
}

function loadAiConfig(user) {
  const store = loadAiStore();
  return Object.assign({}, AI_DEFAULT, store.users[user] || {});
}

function saveAiConfig(user, cfg) {
  const store = loadAiStore();
  store.users[user] = { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey };
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(AI_CONFIG_FILE, 0o600); } catch (e) { /* 忽略 */ }
}

/* ---------- AI 分析历史记录（按账号存成 Markdown） ----------
 * 文件：data/.ai-chat/<账号>.md（隐藏子目录，不会被当成台账列出来）
 * 每条记录用 <!-- wtk-chat id:... --> 分隔，既好读又好解析。
 */
// 每个账号的聊天记录放在自己的目录下：data/<账号>/.ai-chat/<账号>.md
const CHAT_HEAD = '# AI 智能分析记录\n\n> 由「AI智能看板 · AI 智能分析」自动保存；每条包含时间、台账、问题和回答。\n';

function nowStamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function chatFilePath(dir, user) { return path.join(dir, '.ai-chat', safeUserName(user) + '.md'); }
function ensureChatDir(dir) { const d = path.join(dir, '.ai-chat'); try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ } }
function readChatRaw(dir, user) { try { return fs.readFileSync(chatFilePath(dir, user), 'utf8'); } catch (e) { return ''; } }

function parseChatRecords(raw) {
  const recs = [];
  // 按标记切分：parts = [前言, id1, body1, id2, body2, ...]
  const parts = raw.split(/<!--\s*wtk-chat\s+id:(\d+)\s*-->/);
  // parts: [前言, id1, body1, id2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const body = (parts[i + 1] || '').trim();
    const h = body.match(/^##\s*(.+?)\s*·\s*(.+?)\s*$/m);
    const qm = body.match(/\*\*问：\*\*\s*([\s\S]*?)\n+\*\*答：\*\*\s*([\s\S]*)$/);
    const um = body.match(/账号：\s*(.+)/);
    recs.push({
      id: id,
      time: h ? h[1].trim() : '',
      file: h ? h[2].trim() : '',
      user: um ? um[1].trim() : '',
      q: qm ? qm[1].trim() : '',
      a: qm ? qm[2].trim() : body
    });
  }
  return recs;
}

function recordToBlock(rec) {
  return '\n<!-- wtk-chat id:' + rec.id + ' -->\n' +
    '## ' + rec.time + ' · ' + rec.file + '\n' +
    '账号：' + (rec.user || '') + '\n\n' +
    '**问：** ' + String(rec.q || '').replace(/\n+/g, ' ').trim() + '\n\n' +
    '**答：**\n' + String(rec.a || '').trim() + '\n';
}

function appendChatRecord(dir, user, rec) {
  ensureChatDir(dir);
  const f = chatFilePath(dir, user);
  const prefix = fs.existsSync(f) ? '' : CHAT_HEAD;
  try { fs.appendFileSync(f, prefix + recordToBlock(rec), 'utf8'); } catch (e) { /* 忽略写入失败 */ }
}

function writeChatRecords(dir, user, recs) {
  ensureChatDir(dir);
  const body = recs.map(recordToBlock).join('');
  try { fs.writeFileSync(chatFilePath(dir, user), CHAT_HEAD + body, 'utf8'); } catch (e) { /* 忽略 */ }
}

/** 把台账内容包装成 system 提示，让模型先“读懂”再回答 */
function buildAiSystemPrompt(file, content) {
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const today = fmt(now);
  const wk = '日一二三四五六'[now.getDay()];
  const wd = (now.getDay() + 6) % 7;                 // 0=周一
  const monday = new Date(now); monday.setDate(now.getDate() - wd);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return [
    '你是这个人的私人工作助理，负责帮他梳理、总结和分析自己的工作。',
    '下面是他的一份《AI智能看板》（Markdown 文件）：',
    '  · 「任务池」表：列 = 编号 | 任务 | 状态 | 预估人天 | 备注',
    '  · 「排期」表：列 = 编号 | 开始 | 结束',
    '你只能基于这份台账内容回答，不要编造台账里没有的任务；信息不足时请如实说明。',
    '今天日期是 ' + today + '（星期' + wk + '）。本周（周一到周日）是 ' + fmt(monday) + ' 到 ' + fmt(sunday) + '。',
    '涉及日期与星期一律以上面给定的为准，不要自己推算，也不要写错星期；拿不准就先如实说明。',
    '回复用中文，条理清晰、简洁，可用小标题或列表。',
    '用户让你总结时，主动勾出：未完成/进行中的任务、逾期（结束日期早于今天且未完成）、工作量分布等要点。',
    '',
    '===== 台账文件：' + file + ' =====',
    content || '（该台账目前为空）',
    '===== 台账结束 ====='
  ].join('\n');
}

/** 组装一次 chat/completions 请求 */
function aiRequest(cfg, messages, stream, extra) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('还没有配置 API Base URL');
  if (!cfg.apiKey) throw new Error('还没有配置 API Key');
  const body = Object.assign({ model: normalizeModel(cfg.model), messages: messages, stream: !!stream }, extra || {});
  return {
    url: base + '/chat/completions',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body)
    }
  };
}

/** 带超时的 fetch */
async function aiFetch(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 120000);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, init));
  } finally {
    clearTimeout(timer);
  }
}

/** 非流式调用，返回完整文本 */
async function callModel(cfg, messages, opts) {
  const extra = {};
  if (opts && opts.maxTokens) extra.max_tokens = opts.maxTokens;
  const { url, init } = aiRequest(cfg, messages, false, extra);
  const r = await aiFetch(url, init, 60000);
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status + ' ' + text.slice(0, 200)));
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return c || '';
}

/** 流式调用：每收到一段文本就回调 onDelta */
async function streamModel(cfg, messages, onDelta) {
  const { url, init } = aiRequest(cfg, messages, true, {});
  const r = await aiFetch(url, init, 180000);
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => '');
    let j = null; try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status + ' ' + text.slice(0, 200)));
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || line.charAt(0) === ':') continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
        if (d && typeof d.content === 'string' && d.content) onDelta(d.content);
      } catch (e) { /* 忽略半截 JSON */ }
    }
  }
}

/* ------------------------------ 请求处理 ------------------------------ */
const server = http.createServer(async (req, res) => {
  try {
    // 用固定 base 解析请求行，不依赖 Host 头（避免被伪造的 Host 影响解析）
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // ---------- 探活（无需鉴权，用于启动脚本与界面判断服务是否在运行） ----------
    if (pathname === '/api/ping') {
      sendJson(res, { ok: true, app: APP_TAG, auth: authOn });
      return;
    }

    // ---------- 登录 / 退出（这两个接口本身不需要鉴权） ----------
    if (pathname === '/api/login') {
      if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'method not allowed' }, 405); return; }
      if (!authOn) { sendJson(res, { ok: true, message: '未启用访问保护' }); return; }

      const j = await readJson(req);
      let matched = null;
      if (j) {
        for (const u of allAccounts()) {
          if (safeEqual(j.username || '', u.user) && safeEqual(j.password || '', u.pass)) { matched = u; break; }
        }
      }

      if (matched) {
        setAuthCookie(res, matched.user, matched.pass);
        sendJson(res, { ok: true });
      } else {
        // 失败时故意慢一点，抬高暴力破解的时间成本。
        // 提示语不区分"账号错"还是"密码错"，避免帮人确认账号是否存在。
        await new Promise((r) => setTimeout(r, 600));
        sendJson(res, { ok: false, error: '账号或密码不正确' }, 401);
      }
      return;
    }

    if (pathname === '/api/logout') {
      clearAuthCookie(res);
      sendJson(res, { ok: true });
      return;
    }

    // ---------- 访问保护：未通过验证一律挡在外面 ----------
    if (!isAuthed(req)) {
      if (pathname.indexOf('/api/') === 0) {
        sendJson(res, { ok: false, error: 'unauthorized', needLogin: true }, 401);
      } else {
        sendLoginPage(res);          // 页面请求给登录页
      }
      return;
    }

    // ---------- 团队看板：创建 ----------
    if (pathname === '/api/team/create') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const j = (await readJson(req)) || {};
      const name = String(j.name || '').trim().slice(0, 40);
      if (!name) { sendJson(res, { ok: false, error: '请填写看板名称' }, 400); return; }
      const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const t = { id: id, name: name, owner: me.user, createdAt: new Date().toISOString(), members: [] };
      saveTeam(t);
      const d = teamDir(id); ensureLedgerDir(d);
      appendAudit(d, me.user, [{ act: '创建看板', target: name }]);
      sendJson(res, { ok: true, team: { id: id, name: name, file: DEFAULT_FILE, tasks: 0, mtime: getMTime(d, DEFAULT_FILE), members: 0 } });
      return;
    }

    // ---------- 团队看板：操作历史 ----------
    if (pathname === '/api/team/history') {
      const b = resolveBoard(req, url.searchParams.get('team'), null);
      if (!b || !b.team) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      sendJson(res, { ok: true, records: readAudit(b.dir).slice(0, 300) });
      return;
    }

    // ---------- 团队看板：信息 ----------
    if (pathname === '/api/team') {
      const me = authedEntry(req);
      const id = safeTeamId(url.searchParams.get('id'));
      const t = loadTeam(id);
      if (!t) { sendJson(res, { ok: false, error: '团队看板不存在' }, 404); return; }
      const allowed = me && (me.role === 'owner' ? t.owner === me.user : me.teamId === id);
      if (!allowed) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const d = teamDir(id);
      sendJson(res, { ok: true, team: {
        id: t.id, name: t.name, owner: t.owner, createdAt: t.createdAt,
        members: teamMemberUsers(t).map((u) => ({ user: u, name: nameOfMember(u) })),
        tasks: countTasks(d, DEFAULT_FILE)
      } });
      return;
    }

    // ---------- 团队看板：成员增删 / 改团队名 ----------
    if (pathname === '/api/team/member') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const j = (await readJson(req)) || {};
      const t = loadTeam(safeTeamId(j.team));
      if (!t || t.owner !== me.user) { sendJson(res, { ok: false, error: '团队看板不存在' }, 404); return; }
      const users = teamMemberUsers(t);
      const membersOut = () => ({ ok: true, members: users.map((u) => ({ user: u, name: nameOfMember(u) })) });
      const pool = loadMemberPool();

      if (j.op === 'add') {
        let user = String(j.user || '').trim();
        const pass = String(j.pass || '');
        const nm = String(j.name || '').trim();
        if (!user) { sendJson(res, { ok: false, error: '请选择或填写成员账号' }, 400); return; }
        if (USERS.some((u) => u.user === user)) { sendJson(res, { ok: false, error: '该账号名与管理员账号冲突' }, 409); return; }
        const ex = pool.filter((m) => m.user === user)[0];
        if (ex) {
          if (nm && ex.name !== nm) { ex.name = nm; saveMemberPool(pool); }
        } else {
          if (!pass) { sendJson(res, { ok: false, error: '新成员需要设置密码' }, 400); return; }
          pool.push({ user: user, pass: pass, name: nm || user });
          saveMemberPool(pool);
        }
        if (users.indexOf(user) < 0) { users.push(user); t.members = users; saveTeam(t); }
        appendAudit(teamDir(t.id), me.user, [{ act: '添加成员', target: user }]);
        sendJson(res, membersOut());
        return;
      }
      if (j.op === 'del') {
        const user = String(j.user || '').trim();
        t.members = users.filter((u) => u !== user);
        saveTeam(t);
        appendAudit(teamDir(t.id), me.user, [{ act: '移除成员（仅解除关联）', target: user }]);
        sendJson(res, membersOut());
        return;
      }
      if (j.op === 'delAccount') {
        const user = String(j.user || '').trim();
        saveMemberPool(pool.filter((m) => m.user !== user));
        listTeams().forEach((x) => { const us = teamMemberUsers(x); if (us.indexOf(user) >= 0) { x.members = us.filter((u) => u !== user); saveTeam(x); } });
        appendAudit(teamDir(t.id), me.user, [{ act: '删除成员账号', target: user }]);
        sendJson(res, { ok: true });
        return;
      }
      if (j.op === 'rename') {
        const name = String(j.name || '').trim().slice(0, 40);
        if (name) t.name = name;
        saveTeam(t);
        appendAudit(teamDir(t.id), me.user, [{ act: '重命名看板', target: t.name }]);
        sendJson(res, { ok: true, name: t.name });
        return;
      }
      sendJson(res, { ok: false, error: 'unknown op' }, 400);
      return;
    }

    // ---------- 团队看板：删除（移入回收目录，可找回） ----------
    if (pathname === '/api/team/delete') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const j = (await readJson(req)) || {};
      const id = safeTeamId(j.team);
      const t = loadTeam(id);
      if (!t || t.owner !== me.user) { sendJson(res, { ok: false, error: '团队看板不存在' }, 404); return; }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(DATA_ROOT, '_trash', stamp + '_' + id);
      try {
        fs.mkdirSync(path.join(DATA_ROOT, '_trash'), { recursive: true });
        fs.renameSync(teamDir(id), dest);
      } catch (e) {
        try { fs.rmSync(teamDir(id), { recursive: true, force: true }); } catch (e2) { /* 忽略 */ }
      }
      sendJson(res, { ok: true, trash: dest });
      return;
    }

    // ---------- 成员池：列出所有成员账号（仅管理员） ----------
    if (pathname === '/api/members') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const teams = listTeams();
      const members = loadMemberPool().map((m) => ({
        user: m.user, name: m.name || m.user,
        teams: teams.filter((t) => teamMemberUsers(t).indexOf(m.user) >= 0).map((t) => ({ id: t.id, name: t.name }))
      }));
      sendJson(res, { ok: true, members: members });
      return;
    }

    // ---------- 台账列表 ----------
    if (pathname === '/api/files') {
      const me = authedEntry(req);
      if (me && me.role === 'member') {
        const teams = teamsOfMember(me.user).map((t) => {
          const d = teamDir(t.id); ensureLedgerDir(d);
          return { id: t.id, name: t.name, file: DEFAULT_FILE, tasks: countTasks(d, DEFAULT_FILE), mtime: getMTime(d, DEFAULT_FILE), members: teamMemberUsers(t).length };
        });
        sendJson(res, { ok: true, app: APP_TAG, role: 'member', dir: '', default: teams[0] ? teams[0].id : null, files: [], teams: teams });
        return;
      }
      const user = me ? me.user : authedUser(req);
      const dir = ledgerDir(user);
      ensureLedgerDir(dir);
      const teams = teamsOfOwner(user).map((t) => {
        const d = teamDir(t.id);
        ensureLedgerDir(d);
        return { id: t.id, name: t.name, file: DEFAULT_FILE, tasks: countTasks(d, DEFAULT_FILE), mtime: getMTime(d, DEFAULT_FILE), members: (t.members || []).length };
      });
      sendJson(res, { ok: true, app: APP_TAG, role: 'owner', dir: dir, default: DEFAULT_FILE, files: listFiles(dir), teams: teams });
      return;
    }

    // ---------- 台账读写 ----------
    if (pathname === '/api/data') {
      const b = resolveBoard(req, url.searchParams.get('team'), url.searchParams.get('file'));
      if (!b) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const dir = b.dir;
      ensureLedgerDir(dir);
      const name = b.file;
      lastTouchedFile = name;              // 记录给状态面板用

      if (req.method === 'GET') {
        sendJson(res, {
          ok: true,
          app: APP_TAG,
          file: name,
          team: b.team ? b.team.id : null,
          mtime: getMTime(dir, name),
          path: ledgerPath(dir, name),
          content: readData(dir, name)
        });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        const oldText = readData(dir, name);
        // 乐观并发控制：客户端带上它加载时的 mtime（X-Wtk-Base）；与当前不一致则报冲突
        const baseHdr = req.headers['x-wtk-base'];
        if (baseHdr != null && String(baseHdr) !== '') {
          const base = parseInt(baseHdr, 10);
          const cur = getMTime(dir, name);
          if (!isNaN(base) && base > 0 && cur > 0 && base !== cur) {
            sendJson(res, { ok: false, conflict: true, mtime: cur, content: readData(dir, name) }, 409);
            return;
          }
        }
        writeData(dir, name, body);
        if (b.team) { try { appendAudit(dir, b.user, diffTasks(oldText, body)); } catch (e) { /* 忽略 */ } }
        sendJson(res, {
          ok: true, app: APP_TAG, file: name,
          mtime: getMTime(dir, name),
          time: new Date().toTimeString().slice(0, 8)
        });
        return;
      }
      sendJson(res, { ok: false, error: 'method not allowed' }, 405);
      return;
    }

    // ---------- 导出台账（下载 .md 原文） ----------
    if (pathname === '/api/export') {
      const b = resolveBoard(req, url.searchParams.get('team'), url.searchParams.get('file'));
      if (!b) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const name = b.file;
      const buf = Buffer.from(readData(b.dir, name), 'utf8');
      const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': buf.length,
        'Content-Disposition': 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
        'Cache-Control': 'no-store'
      });
      res.end(buf);
      return;
    }

    // ---------- 新建台账 ----------
    if (pathname === '/api/files/create') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const j = await readJson(req);
      const name = j && normalizeNewName(j.name);
      if (!name) { sendJson(res, { ok: false, error: '文件名不合法，请使用中文/英文/数字，自动补 .md 后缀' }, 400); return; }
      const dir = ledgerDir(me.user);
      ensureLedgerDir(dir);
      const target = ledgerPath(dir, name);
      if (fs.existsSync(target)) { sendJson(res, { ok: false, error: '同名台账已存在：' + name }, 409); return; }
      fs.writeFileSync(target, TEMPLATE, 'utf8');
      sendJson(res, { ok: true, file: name, files: listFiles(dir) });
      return;
    }

    // ---------- 重命名台账 ----------
    if (pathname === '/api/files/rename') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const j = await readJson(req);
      const from = j && safeMdName(j.from);
      const to = j && normalizeNewName(j.to);
      if (!from || !to) { sendJson(res, { ok: false, error: '文件名不合法' }, 400); return; }
      const dir = ledgerDir(me.user);
      if (from === to) { sendJson(res, { ok: true, file: to, files: listFiles(dir) }); return; }
      if (!fs.existsSync(ledgerPath(dir, from))) { sendJson(res, { ok: false, error: '待重命名的台账不存在：' + from }, 404); return; }
      if (fs.existsSync(ledgerPath(dir, to))) { sendJson(res, { ok: false, error: '同名台账已存在：' + to }, 409); return; }
      fs.renameSync(ledgerPath(dir, from), ledgerPath(dir, to));
      sendJson(res, { ok: true, from: from, file: to, files: listFiles(dir) });
      return;
    }

    // ---------- 删除台账（移入 .trash） ----------
    if (pathname === '/api/files/delete') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const j = await readJson(req);
      const name = j && safeMdName(j.name);
      if (!name) { sendJson(res, { ok: false, error: '文件名不合法' }, 400); return; }
      const dir = ledgerDir(me.user);
      if (!fs.existsSync(ledgerPath(dir, name))) { sendJson(res, { ok: false, error: '台账不存在：' + name }, 404); return; }
      const total = listFiles(dir).length;
      if (total <= 1) { sendJson(res, { ok: false, error: '至少要保留一个台账文件' }, 400); return; }
      const dest = trashFile(dir, name);
      sendJson(res, { ok: true, file: name, trash: dest, files: listFiles(dir) });
      return;
    }

    // ---------- 在文件管理器中打开台账目录 ----------
    if (pathname === '/api/open-dir') {
      const me = authedEntry(req);
      if (!me || me.role !== 'owner') { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const dir = ledgerDir(me.user);
      if (process.platform === 'win32') exec('explorer "' + dir + '"', { windowsHide: true }, () => {});
      else if (process.platform === 'darwin') exec('open "' + dir + '"', () => {});
      else exec('xdg-open "' + dir + '"', () => {});
      sendJson(res, { ok: true, dir: dir });
      return;
    }

    // ---------- 服务状态（界面上的「服务状态」面板用） ----------
    if (pathname === '/api/status') {
      sendJson(res, {
        ok: true,
        app: APP_TAG,
        port: currentPort,
        pid: process.pid,
        startedAt: SERVER_STARTED_AT,
        uptimeMs: Date.now() - SERVER_STARTED_AT,
        dir: ledgerDir(authedUser(req)),
        role: (authedEntry(req) || {}).role || 'owner',
        teamId: (authedEntry(req) || {}).teamId || null,
        file: currentFile(),
        node: process.version,
        platform: process.platform,
        appMode: appMode,
        auth: authOn,                 // 是否启用了访问保护
        user: authedUser(req) || (authOn ? '' : username),    // 当前登录账号
        weakPass: authOn && isWeakPassword((authedEntry(req) || {}).pass || ''),  // 当前账号密码是否偏弱
        host: host
      });
      return;
    }

    // ---------- AI 对话：读取 / 保存配置（不回传 Key 明文） ----------
    if (pathname === '/api/ai/config') {
      const me = authedUser(req);
      if (req.method === 'GET') {
        const cfg = loadAiConfig(me);
        sendJson(res, {
          ok: true,
          user: me,
          provider: cfg.provider,
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          hasKey: !!cfg.apiKey,
          keyTail: cfg.apiKey ? cfg.apiKey.slice(-4) : '',
          providers: Object.keys(AI_PROVIDERS).map((k) => ({ id: k, label: AI_PROVIDERS[k].label, baseUrl: AI_PROVIDERS[k].baseUrl, models: AI_PROVIDERS[k].models }))
        });
        return;
      }
      if (req.method === 'POST') {
        const j = (await readJson(req)) || {};
        const cfg = loadAiConfig(me);
        if (typeof j.provider === 'string' && AI_PROVIDERS[j.provider]) cfg.provider = j.provider;
        if (typeof j.baseUrl === 'string') cfg.baseUrl = j.baseUrl.trim();
        if (typeof j.model === 'string' && j.model.trim()) cfg.model = j.model.trim();
        // apiKey 传空表示“不修改”，只有传了新值才覆盖
        if (typeof j.apiKey === 'string' && j.apiKey.trim()) cfg.apiKey = j.apiKey.trim();
        if (!cfg.baseUrl && AI_PROVIDERS[cfg.provider]) cfg.baseUrl = AI_PROVIDERS[cfg.provider].baseUrl;
        saveAiConfig(me, cfg);
        sendJson(res, { ok: true, user: me, provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, hasKey: !!cfg.apiKey, keyTail: cfg.apiKey ? cfg.apiKey.slice(-4) : '' });
        return;
      }
      sendJson(res, { ok: false, error: 'method not allowed' }, 405);
      return;
    }

    // ---------- AI 对话：连通性测试 ----------
    if (pathname === '/api/ai/test') {
      try {
        const out = await callModel(loadAiConfig(authedUser(req)), [{ role: 'user', content: '你好，请只回复两个字：可用' }], { maxTokens: 20 });
        sendJson(res, { ok: true, reply: String(out).trim().slice(0, 60) });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
      }
      return;
    }

    // ---------- AI 智能分析：历史记录（按当前账号） ----------
    if (pathname === '/api/ai/history') {
      const b = resolveBoard(req, url.searchParams.get('team'), null);
      if (!b) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const recs = parseChatRecords(readChatRaw(b.dir, b.user));
      recs.reverse();                 // 最新的排前面
      sendJson(res, { ok: true, count: recs.length, records: recs.slice(0, 100) });
      return;
    }
    if (pathname === '/api/ai/history/delete') {
      const b = resolveBoard(req, url.searchParams.get('team'), null);
      if (!b) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const j = (await readJson(req)) || {};
      const id = String(j.id || '');
      const recs = parseChatRecords(readChatRaw(b.dir, b.user)).filter((r) => r.id !== id);
      writeChatRecords(b.dir, b.user, recs);
      sendJson(res, { ok: true, count: recs.length });
      return;
    }
    if (pathname === '/api/ai/history/clear') {
      const b = resolveBoard(req, url.searchParams.get('team'), null);
      if (!b) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      writeChatRecords(b.dir, b.user, []);
      sendJson(res, { ok: true });
      return;
    }

    // ---------- AI 对话：流式问答（SSE） ----------
    if (pathname === '/api/ai/chat') {
      if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'method not allowed' }, 405); return; }
      const cfg = loadAiConfig(authedUser(req));
      if (!cfg.apiKey) { sendJson(res, { ok: false, error: '还没有配置 API Key，请先在设置里填写', needConfig: true }, 400); return; }

      const j = (await readJson(req)) || {};
      const b = resolveBoard(req, j.team, j.file);
      if (!b) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return; }
      const dir = b.dir;
      const fileName = b.file;
      const content = readData(dir, fileName) || '';
      lastTouchedFile = fileName;

      const history = Array.isArray(j.messages)
        ? j.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).slice(-12)
        : [];
      const messages = [{ role: 'system', content: buildAiSystemPrompt(fileName, content) }].concat(history);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const push = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* 连接已断 */ } };
      let full = '';
      try {
        await streamModel(cfg, messages, (delta) => { full += delta; push({ delta: delta }); });
        push({ done: true });
        if (full.trim()) {
          const lastUser = history.filter((m) => m.role === 'user').slice(-1)[0];
          try {
            appendChatRecord(dir, b.user, {
              id: String(Date.now()),
              time: nowStamp(),
              file: fileName,
              user: b.user,
              q: (lastUser && lastUser.content) || '',
              a: full
            });
          } catch (e2) { /* 存历史失败不影响回答 */ }
        }
      } catch (e) {
        push({ error: String(e && e.message ? e.message : e) });
      }
      res.end();
      return;
    }

    // ---------- 重启服务 ----------
    if (pathname === '/api/restart') {
      sendJson(res, { ok: true, message: '正在重启本地服务' });
      restartLater();
      return;
    }

    // ---------- 关闭服务（界面上的「停止服务」按钮） ----------
    if (pathname === '/api/quit') {
      sendJson(res, { ok: true, message: '服务已停止' });
      setTimeout(() => process.exit(0), 120);
      return;
    }

    // ---------- 静态文件（index.html 等，来自程序目录） ----------
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.resolve(APP_DIR, '.' + rel);

    // 安全校验：禁止越出程序目录
    if (filePath !== APP_DIR && !filePath.startsWith(APP_DIR + path.sep)) {
      sendText(res, 'forbidden', 403);
      return;
    }
    // 隐藏文件（.server-port、.trash 等）不对外提供
    if (path.basename(filePath).startsWith('.')) {
      sendText(res, 'not found', 404);
      return;
    }
    // 台账文件不走静态通道，统一由 /api/data 提供（避免绕过校验）
    if (/\.md$/i.test(filePath)) {
      sendText(res, 'not found', 404);
      return;
    }
    // 程序源码本身也不需要对外提供
    if (STATIC_BLOCKED.indexOf(path.basename(filePath).toLowerCase()) >= 0) {
      sendText(res, 'not found', 404);
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendText(res, 'not found', 404);
      return;
    }
    const body = fs.readFileSync(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (err) {
    sendText(res, 'server error: ' + (err && err.message ? err.message : err), 500);
  }
});

/* ------------------------------ 启动（端口占用则顺延） ------------------------------ */

/** 探测某端口上是否已经跑着本工具的服务（避免重复启动、重复开窗口） */
function probeRunning(p, cb) {
  // 探测本机端口：固定走 127.0.0.1，与对外监听地址无关。
  // 用 /api/ping（免鉴权）而不是 /api/data，否则启用访问保护时会误判为「服务不在」
  const req = http.get({ host: '127.0.0.1', port: p, path: '/api/ping', timeout: 800 }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try {
        const j = JSON.parse(data);
        cb(!!(j && j.ok && j.app === APP_TAG));
      } catch (e) { cb(false); }
    });
  });
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.on('error', () => cb(false));
}

function listen(p, tried) {
  tried = tried || 0;
  const onError = (err) => {
    server.removeListener('error', onError);

    // 「重启服务」拉起的子进程：旧进程可能还没完全放开端口，稍等再试同一个端口
    if (err.code === 'EADDRINUSE' && restartWait && tried < 40) {
      setTimeout(() => listen(p, tried + 1), 150);
      return;
    }
    if (err.code === 'EADDRINUSE' && tried < MAX_PORT_TRY) {
      listen(p + 1, tried + 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  };
  server.on('error', onError);
  server.listen(p, host, () => {
    server.removeListener('error', onError);
    currentPort = p;
    restartWait = false;              // 端口已拿到，后续再遇到占用就正常顺延
    const localUrl = 'http://localhost:' + p + '/';
    const anyUrl = 'http://' + (host === '0.0.0.0' ? '服务器IP' : host) + ':' + p + '/';
    // 记录实际端口，供启动脚本与排查使用
    try { fs.writeFileSync(PORT_FILE, String(p), 'utf8'); } catch (e) { /* 忽略 */ }

    const isPublic = host !== '127.0.0.1' && host !== 'localhost';

    console.log('');
    console.log('  AI智能看板已启动');
    console.log('  监听地址：' + host + ':' + p);
    console.log('  本机访问：' + localUrl);
    if (isPublic) console.log('  对外访问：' + anyUrl + '   （把「服务器IP」换成你服务器的实际地址）');
    console.log('  数据根目录：' + DATA_ROOT + '（每个账号一个子目录）');
    console.log('  访问保护：' + (authOn ? '已开启，需要密码' : (noAuth ? '已手动关闭（⚠ 无密码保护）' : '未开启（仅本机可访问，无需密码）')));
    if (authOn) console.log('  登录账号：' + username);

    // 对外服务还用了弱口令：明确警告，避免数据在网上裸奔
    if (isPublic && authOn && isWeakPassword(accessPassword)) {
      console.log('');
      console.log('  ⚠ 警告：服务已对外开放，但当前密码过于简单（' + accessPassword + '），');
      console.log('    很容易被网上的人试出来。建议尽快换成 12 位以上的复杂密码：');
      console.log('      1) 编辑 .env，把 WTK_PASS 改成新密码（WTK_USER 是登录账号）');
      console.log('      2) 执行  bash start.sh restart');
    }

    // 自动生成的密码只打印在日志里，服务器上可从这里查到
    if (generatedPassword) {
      console.log('');
      console.log('  ⚠ 你对外开启了服务但没有设置密码，已自动生成一个：');
      console.log('');
      console.log('      访问密码：' + generatedPassword);
      console.log('');
      console.log('    请记下这个密码；想固定密码，可用环境变量 WTK_PASS 指定后重启服务。');
    }

    if (!appMode) console.log('  打开方式：系统默认浏览器');
    console.log('  停止服务：Ctrl+C 关闭，或执行  pkill -f server.js');
    console.log('');
    if (autoOpen && !isPublic) openUI(localUrl);   // 对外服务时不自动开浏览器（服务器上没必要）
  });
}

// 退出时清理端口文件
function cleanup() {
  try { if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE); } catch (e) { /* 忽略 */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

/**
 * 重启服务：先放开端口，再以同样的参数拉起一个新进程，最后自己退出
 * 顺序很重要 —— 必须等端口真正释放后子进程才能绑上同一个端口，
 * 否则子进程会认为"服务已在运行"而直接退出，重启就失败了。
 */
function restartLater() {
  // 界面请求已经在上面回复完了，这里稍等一下再动手
  setTimeout(() => {
    const launch = () => {
      // 保留原来的启动参数（去掉旧的 --port，用实际监听到的端口）
      const args = process.argv.slice(2).filter((a) => !/^--port=\d+$/.test(a) && a !== '--restart-wait');
      args.push('--port=' + currentPort, '--restart-wait');

      const child = spawn(process.execPath, [__filename].concat(args), {
        detached: true,        // 新进程独立于本进程，父进程退出不会带走它
        stdio: 'ignore',
        cwd: process.cwd(),
        windowsHide: true
      });
      child.unref();
      process.exit(0);
    };

    try {
      // 强制断开现有连接（包括界面正在用的 keep-alive），否则端口不会真正释放
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(launch);
      // 兜底：个别环境下 close 回调可能迟迟不来，最多等 1.5 秒
      setTimeout(launch, 1500);
    } catch (e) {
      process.exit(0);
    }
  }, 200);
}

// 若服务已在运行，就直接打开页面，不再启动第二个实例
probeRunning(port, (running) => {
  if (running) {
    const isPublic = host !== '127.0.0.1' && host !== 'localhost';
    const url = 'http://localhost:' + port + '/';
    console.log('  检测到任务看板服务已在运行：' + url);
    console.log('  如需重启，可在界面右上角「服务运行中」面板里重启，或执行 pkill -f server.js');
    if (autoOpen && !isPublic) openUI(url);
    process.exit(0);
  }
  listen(port);
});
