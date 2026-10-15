/**
 * 用火山方舟 Seedream 图片模型，为「猫猫桌宠」的各动作生成绿幕首帧。
 *
 * 为什么需要它：
 *   之前所有动作都拿同一张「站立」图当首帧，模型被这张图带跑 ——
 *   比如「睡觉」只能从站姿一路演变成蜷缩，动作又长又假，还容易被裁切。
 *   这里为每个动作单独生成「该动作的姿势」，再交给视频模型做动作。
 *
 * 产物（cat-media/refs/actions/）：
 *   <key>-first.png  动作起始姿势
 *   <key>-last.png   尾帧，与首帧内容完全相同
 *
 * 关于首尾帧为什么要一样：
 *   这些动作都是「循环动作」（待机/瞌睡/睡觉/洗脸/跳跃都要一直重复），
 *   首尾同姿势才能天然闭环，接回挂件时不会出现跳帧的突兀感。
 *   做法是首帧生成一次，尾帧直接复制同一份，保证像素级一致。
 *
 * 用法：
 *   $env:ARK_KEY='ark-xxx'; node gen_action_frames.mjs            # 生成全部
 *   $env:ARK_KEY='ark-xxx'; node gen_action_frames.mjs sleep hop  # 只生成指定动作
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(ROOT, 'refs', 'green', 'E2-peach-green-00B140.png');
const OUTDIR = path.join(ROOT, 'refs', 'actions');

const KEY = process.env.ARK_KEY;
const MODEL = process.env.ARK_MODEL || 'doubao-seedream-4-0-20260415';
const SIZE = process.env.ARK_SIZE || '1024x1024';
const API = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

/* 构图：用显式数字约束主体大小与留白。
   模型对「和参考图一样大」这类相对描述不敏感，必须给具体比例，
   否则它会按姿势自行缩放（实测伸懒腰只画到参考图的 55% 大小，跳跃则直接画出画面被切断）。 */
const FRAMING = `画面构图：正方形画幅，猫位于画面正中央。
猫的完整轮廓（含两只耳朵、尾巴尖、四只爪子）其水平跨度不超过画面宽度的 78%、
垂直跨度不超过画面高度的 78%；猫的底边（爪子或身体最低点）距离画面下边缘不少于画面高度的 12%；
四边空白均不少于画面宽度的 12%。绝不允许任何部位接触或超出画面边缘。`;

/* 所有动作共用的硬约束。
   放在提示词最前面 —— 模型对开头部分的权重最高。 */
const BASE = `纯绿色单色背景，色值 #00B140 的饱和草绿色，背景必须完全均匀平整，
没有任何渐变、纹理、噪点、光影变化；背景里不要出现地面、地板、桌面、房间、道具、植物或任何场景元素。
${FRAMING}
镜头完全固定，正面平视。
不要文字、数字、水印、logo、边框、时间码。`;

/* 角色一致性：必须和参考图是同一只猫。
   ⚠ 「长毛蓬松」这个描述不能少，更不能写成「短毛」——
   参考图（E2-peach-green）本身是长毛猫、尾巴毛量很足；
   早先这里误写成「蜜桃橘色短毛小猫」，模型以文字描述为准，
   把猫画成了短毛、尾巴变细，与走路 / 站立素材明显不是同一只。 */
const SAME_CAT = `画面中的猫必须与参考图里的猫完全相同：同一只蜜桃橘色（暖橘偏粉）长毛小猫，
毛发丰厚蓬松：颈侧与胸前有一圈柔软的绒毛，四肢的轮廓毛茸茸的，
尾巴是一大团蓬松的毛、明显比身体更粗、毛量很足。
同样的毛色与条纹分布、同样的脸型与眼睛颜色、同样的体型比例、同样的绘画风格与笔触。
绝对不要画成短毛或毛发光滑贴身的样子，尾巴绝不能是细长光滑的。
不要换品种，不要改变毛色，不要出现第二只猫。`;

/* 六个动作。pose 是该动作「最具代表性的一帧姿势」，用于生成静态首帧。
   reuseRef: true 表示不生成、直接复用参考图 —— 参考图本身就是「站立」姿势，
   若重新生成会得到一只条纹/色调略有差异的猫，与已有的 walk 素材切换时会突跳。 */
const ACTIONS = [
  {
    key: 'idle',
    cn: '待机站立',
    reuseRef: true,
  },
  {
    key: 'doze',
    cn: '打瞌睡',
    pose: `标准的猫坐姿：后腿弯曲坐着，前爪并拢撑在身前，身体竖起，
眼睛闭成弯弯的弧线，脑袋微微向下低垂，尾巴松弛地绕在身前地面上。`,
  },
  {
    key: 'sleep',
    cn: '睡觉',
    pose: `侧躺蜷缩成一团睡觉的姿势：身体缩成圆润的一团趴在地面上，
四条腿收在身体下方只露出爪尖，尾巴从身后绕过来包住身体，
脑袋枕在前爪上，眼睛完全闭上，神态安详。`,
  },
  {
    key: 'stretch',
    cn: '伸懒腰',
    pose: `伸懒腰的最高点姿势：两条前爪向前伸出平贴在地面上，
前胸贴近地面，背部高高弓起，后腿伸直、屁股向上翘起，尾巴向上翘起，眼睛闭着。`,
  },
  {
    key: 'groom',
    cn: '舔毛洗脸',
    // 这里必须把「三条腿着地」写死：早先只说了「另一只前爪撑在地上」，
    // 完全没约束后爪，模型就自由发挥，画出「前爪和后爪同时抬起」的别扭姿势。
    pose: `坐着的洗脸姿势：猫安静地坐在自己屁股上，两只后腿都弯曲收在身下、
两只后爪连同小腿一起平贴在地面上承重，后腿不抬起、不向两侧张开撑地。
两只前爪中只有一只抬起、举到脸侧；另一只前爪稳稳撑在地面上。
始终有且仅有一只爪子离地（抬起的是一只前爪），其余三只爪子全部贴在地面上。
脑袋微微侧过去靠近抬起的爪子，舌头露出一小截，尾巴悠闲地摊在身后地面上。`,
  },
  {
    key: 'hop',
    cn: '开心跳',
    // 首帧要「四脚着地的蓄力蹲伏」：起跳循环应从地面开始，
    // 若给悬空帧，视频会从半空中开始，接回循环时很突兀。
    pose: `四只爪子全部踩在地面上、身体压低蹲伏的蓄力姿势：
四条腿都弯曲、肚子贴近地面，背部略微拱成圆弧，尾巴平贴地面向后伸直，
两只耳朵向前竖起，眼睛睁大发亮盯着前方，整体呈「准备向上起跳」的压缩姿态。`,
  },
];

/** 拼出该动作的完整提示词 */
function buildPrompt(a) {
  return `${BASE}\n${SAME_CAT}\n\n猫的具体姿势：${a.pose}\n\n画面为正方形构图，写实风格的柔和上色，摄影棚级别的均匀柔光。`;
}

async function generate(a) {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const first = path.join(OUTDIR, `${a.key}-first.png`);
  const last = path.join(OUTDIR, `${a.key}-last.png`);

  // 复用参考图的动作：直接拷贝，保证与既有素材同一只猫
  if (a.reuseRef) {
    fs.copyFileSync(REF, first);
    fs.copyFileSync(REF, last);
    return `${a.key}-first.png（复用参考图）`;
  }

  const refB64 = fs.readFileSync(REF).toString('base64');
  const body = {
    model: MODEL,
    prompt: buildPrompt(a),
    // 传参考图做「图生图」，用来锁住同一只猫的外形与画风
    image: `data:image/png;base64,${refB64}`,
    size: SIZE,
    response_format: 'b64_json',
    watermark: false,
  };
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`响应不是 JSON: ${text.slice(0, 300)}`); }
  const item = (j.data || [])[0];
  if (!item) throw new Error(`响应里没有图片: ${text.slice(0, 300)}`);

  if (item.b64_json) {
    fs.writeFileSync(first, Buffer.from(item.b64_json, 'base64'));
  } else if (item.url) {
    const ir = await fetch(item.url);
    fs.writeFileSync(first, Buffer.from(await ir.arrayBuffer()));
  } else {
    throw new Error(`既无 b64_json 也无 url: ${Object.keys(item).join(',')}`);
  }
  // 尾帧 = 首帧的副本，保证首尾像素级一致（循环动作才能无缝闭环）
  fs.copyFileSync(first, last);
  return path.basename(first);
}

const want = process.argv.slice(2);
const list = want.length ? ACTIONS.filter((a) => want.includes(a.key)) : ACTIONS;
if (!KEY) { console.error('缺少 ARK_KEY 环境变量'); process.exit(1); }
if (!list.length) { console.error('没有匹配的动作，可选: ' + ACTIONS.map((a) => a.key).join(' ')); process.exit(1); }

console.log(`模型 ${MODEL}  尺寸 ${SIZE}`);
let fail = 0;
for (const a of list) {
  process.stdout.write(`  ${a.key.padEnd(8)} ${a.cn} … `);
  try {
    const p = await generate(a);
    console.log(`OK  ${path.basename(p)}`);
  } catch (e) {
    fail++;
    console.log(`失败  ${e.message}`);
  }
}
console.log(`\n完成 ${list.length - fail}/${list.length}，输出目录: ${OUTDIR}`);
