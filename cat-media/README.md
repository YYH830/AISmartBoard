# 猫猫桌宠 · 素材处理工具（使用说明）

> 这个目录是**桌宠动画的加工车间**：把绿幕动作视频变成应用里能用的透明动图。
> 面向接手的人（比如服务器上的龙虾）：照着本文的流程走，就能独立完成一个新动作。

---

## 一、这个目录里有什么、和别的目录什么关系

```
仓库根/
├── app/
│   ├── index.html            ← 动作在这里注册（CAT_ACTIONS / ROTATION）
│   └── assets/cat/           ← ★ 交付目标：处理好的 cat-*.webp + .json
└── cat-media/                ← 本目录：加工车间（工具 + 文档）
    ├── README.md             ← 本文
    ├── 猫猫动作提示词.md      ← 六个动作的完整提示词 + 避坑要点
    ├── inbox/                ← 输入：放绿幕 mp4（不入库）
    ├── processed/            ← 中间产物与成品（不入库）
    ├── refs/                 ← 参考图（首尾帧 / 绿幕底图）
    └── *.py / *.mjs          ← 工具脚本（入库）
```

**只有工具脚本、两份文档、以及 `refs/green/` 里的绿幕底图会同步到 GitHub。**
原始视频、抠图中间帧、密钥、质检临时图都不入库（规则见仓库根 `.gitignore`），
所以在别的机器上刚开始时 `inbox/` 和 `processed/` 是空的，这是正常的。

---

## 二、环境准备

| 依赖 | 用途 | 安装 |
|---|---|---|
| Python 3 | 跑所有 `.py` | — |
| `numpy` | 全流程数值计算 | `pip install numpy` |
| `Pillow` | 图像读写、拼图 | `pip install pillow` |
| `PyAV`（`av`） | 解码 mp4 | `pip install av` |
| `opencv-python`（`cv2`） | 只看轨迹用的诊断脚本 | `pip install opencv-python` |
| Node.js 18+ | 只在生成首尾帧时用 | 内置 `fetch`，无额外依赖 |

> Windows 控制台默认 GBK，中文会乱码。跑之前先执行 `chcp 65001`，
> 或者给 Python 加上 `$env:PYTHONIOENCODING='utf-8'`。脚本内部也已经尽量强制 UTF-8 输出。

---

## 三、完整流程：从一段绿幕视频到应用里的动图

假设要加一个叫 `hop`（开心跳）的动作。

### ① 生成首尾帧（首尾帧已存在则跳过）

```powershell
$env:ARK_KEY='ark-xxx'
node gen_action_frames.mjs hop          # 只生成 hop；不带参数则生成全部
```

产物：`refs/actions/hop-first.png` 和 `hop-last.png`（当前实现里两者内容相同）。

- 脚本用**图生图**，参考图固定为 `refs/green/E2-peach-green-00B140.png`，
  用来锁住「同一只猫」的外形与画风。
- **密钥只从环境变量 `ARK_KEY` 读**，不读 `.ark-key` 文件，所以仓库里不需要放密钥。
- 首尾帧姿态怎么定，见 `猫猫动作提示词.md` 的附录。

### ② 用视频模型把首尾帧做成动作视频（人工步骤）

在网页端的「图生视频」里：**首帧填 `hop-first.png`，尾帧填 `hop-last.png`**。
下载得到的 mp4 放进 `inbox/`。

> 提示词直接整段复制 `猫猫动作提示词.md` 第四节对应那一段。
> 参数建议：640×640、24fps、6~8 秒（太短会找不到无缝循环段）。

### ③ 视频体检（**必做**，不合格别往下走）

```powershell
python check_cat_video.py inbox/hop.mp4
```

看三项：绿幕是否干净、**猫有没有被画面边缘裁切**、是不是原地动作。
它同时会出一张带红色安全边距框的抽帧拼图 `check-sheet.png`，人眼复核。

### ④ 搜最优循环窗口

```powershell
python _vsloop.py inbox/hop.mp4 --minlen 18 --top 12
```

它在**源视频**上用绿幕掩码全量枚举所有窗口，按 `闭合差 ÷ 逐帧相邻差` 打分，
**越小越无缝**（≤1.6 算合格）。记下最优区间，例如 `19~41`。

- 若某些帧主体贴边（抠图后会有平直硬边），用 `--exclude 36 66` 把它们排掉。
- 这一步很快（单个视频十几秒），**不用先抠图**，可以放心多试几轮。

### ⑤ 抠图 + 出动图

```powershell
# 普通原地动作
python process_walk.py inbox/hop.mp4 --out cat-hop --range 19 41 --no-search --tight

# 跳跃类动作（有垂直位移）必须多一个 --keep-v，否则跳不起来，见第六节
python process_walk.py inbox/hop.mp4 --out cat-hop --range 19 41 --no-search --tight --keep-v
```

成品写到 `processed/cat-hop.webp`（另附 `.gif` / `.json` / `-frames/`）。
控制台会打印循环质量，并自动做一次「平直切边」质检。

> 不想自己搜窗口时，去掉 `--range ... --no-search`，脚本会自动挑一段。
> 但自动挑的结果必须先看循环质量再用，见第六节第 4 条。

### ⑥ 质检

```powershell
python check_action_flow.py  ../app/assets/cat      # 帧序有没有乱
python check_action_scale.py ../app/assets/cat idle # 各动作屏幕尺度是否一致
```

详细判读见第七节。

### ⑦ 交付

1. 把 `processed/cat-hop.webp` 和 `processed/cat-hop.json` 拷到 `../app/assets/cat/`
2. 在 `../app/index.html` 的 `CAT_ACTIONS` 里加一行：

   ```javascript
   hop: { file: 'cat-hop.webp', moves: false, scale: 1.15 }
   ```

   - `moves: true` 只给「会带着猫位移」的动作（目前只有走路）
   - `scale` 按 `check_action_scale.py` 的建议填
3. 把它加进 `ROTATION` 数组

> 注：早先每个动作还有 `roam: false`（禁止这个动作期间随机换位置）。
> 现在改成「只在**切换动作的那一刻**按概率换位置」，猫是先淡出、再在新位置以
> 新姿势出现，读起来是"溜达到别处去了"，不需要按动作逐个开关，这个字段已删除。

---

## 四、脚本清单

### 主力管线

| 脚本 | 作用 | 用法 |
|---|---|---|
| `process_walk.py` | **主力**：绿幕抠图 → 对齐 → 找循环 → 出透明动图 | `python process_walk.py inbox/x.mp4 --out cat-x --tight` |
| `repack_loop.py` | **快改循环**：拿已抠好的帧重挑区段，几秒一轮，不用等抠图 | `python repack_loop.py processed/cat-x-frames --out cat-x --range 30 60` |
| `gen_action_frames.mjs` | 调火山方舟生成各动作首尾帧 | `node gen_action_frames.mjs hop` |

`process_walk.py` 全部选项：

| 选项 | 说明 |
|---|---|
| `--out 名` | 输出名，决定 `processed/<名>.webp` |
| `--range A B` | 只处理指定帧区间（默认自动挑最长可用区段） |
| `--no-search` | **不自动搜循环段**，把 `--range` 区间整段当循环用 |
| `--keep-v` | **保留垂直位移**（跳跃类动作必加） |
| `--tight` | 贴紧猫体裁掉留白（**与既有素材的约定一致，务必加**） |
| `--height N` | 输出高度，默认 160 |
| `--stride N` | 每隔 N 帧取一帧，减小体积 |
| `--pingpong` | 强制乒乓循环（正放+倒放） |
| `--allow-clip` | 允许含出框帧（会有硬边，非必要别用） |
| `--dump-all` | 额外导出未选段的全量对齐帧到 `processed/<名>-all/` |
| `--lossy Q` | 有损质量（如 88）；**不传则无损，体积约大 2 倍** |

`repack_loop.py` 选项：`--out` / `--range A B` / `--pingpong` / `--stride N` / `--lossy Q` / `--profile`（只打印逐帧变化曲线，不导出）。

### 诊断工具（排查问题时用）

| 脚本 | 作用 | 用法 |
|---|---|---|
| `_vsloop.py` | 在源视频上全量搜最佳循环窗口，可排除出框帧 | `python _vsloop.py inbox/x.mp4 --exclude 36 66 --top 12` |
| `_bestloop.py` | 在**已抠好的帧**里搜最佳窗口 | `python _bestloop.py cat-x-frames --only 97 --minlen 14` |
| `_headtrace.py` | 量猫体包围盒轨迹，判断动作节律 | `python _headtrace.py inbox/x.mp4 0 96 _trace.png` |
| `_catcmp.py` | 按应用真实渲染尺寸并排对比各动作，查大小突变 | `python _catcmp.py 对照.png` |
| `_period.py` | 扫自相似周期（探索动作节律，偏实验性） | `python _period.py cat-x-frames 46` |

### 质检脚本

| 脚本 | 检查什么 | 用法 |
|---|---|---|
| `check_cat_video.py` | 源视频：绿幕 / 裁切 / 位移 | `python check_cat_video.py inbox/x.mp4` |
| `check_action_frames.py` | 首尾帧：绿幕 / 裁切 / 各动作位置一致性 | `python check_action_frames.py` |
| `cat_check.py` | **毛发长度**（防"长毛变短毛"）/ 毛色一致性 / 尺寸占比 | `python cat_check.py` |
| `cat_compare.py` | 同猫对照图：app 现用素材 + 参考图 + 各动作首帧，按体高对齐 | `python cat_compare.py` |
| `check_action_flow.py` | **帧序**有没有乱（D2/D1 判据） | `python check_action_flow.py ../app/assets/cat` |
| `check_action_scale.py` | 各动作**屏幕尺度**，算出需要的 `scale` | `python check_action_scale.py ../app/assets/cat idle` |
| `check_loop.py` | 循环闭合质量（gap vs step） | `python check_loop.py cat-x` |

> `cat_check.py` 的毛发指标只是**粗略提示**（脚本自己也会声明这一点）：
> 它能发现"整批都变短毛了"这类系统性偏差，但单个动作 70%~90% 的差异不可靠，
> **最终以 `cat_compare.py` 出的对照图人眼判断为准**。

### 应用侧验证

| 脚本 | 作用 | 用法 |
|---|---|---|
| `test_rotation.js` | 猫猫逻辑的**无界面回归测试**：把 index.html 里的猫猫 IIFE 抽出来，喂 DOM 桩 + 假时钟 + 可编排的假 `Math.random`，验证**随机节奏**、单击换动作/不挪窝、双击换位置、拖拽、以及「动作切换」设置项确已移除，共 9 个场景、31 项断言 | `node test_rotation.js` |
| `mock-nginx-subpath.js` | 本机模拟 nginx 的 `/board/` 子路径反代，验证**子路径部署**下素材能否正常加载 | `node mock-nginx-subpath.js` |

`test_rotation.js` 改完 `ROTATION`、切换节奏或交互后**务必跑一遍**。它的期望值全部
从 `index.html` 里解析（`ROTATION` / `SWITCH_MIN_SEC` / `SWITCH_MAX_SEC` / `TELEPORT_P`），
加动作或调区间都不必改测试本身。失败时退出码为 1，可以直接挂到 CI 上。

---

## 五、打包约定（**铁律**）

这几条直接决定「切换动作时猫会不会突然变大变小」，改动前务必理解。

1. **一律 `--tight`**：动画帧对齐后，必须把「所有帧的并集外接框」之外的留白裁掉。
   应用里图片是 `width:100%`，容器宽固定，所以**素材宽高比 = 屏幕上猫的宽高比**。
   不裁的话，不同动作的留白量不同，切换时会跳大小。

2. **统一 `--height 160`**：所有动作的输出高度一致，否则同一容器下尺寸不可比。

3. **帧名定宽补零**：`process_walk.py` 会按总帧数决定位数（`00.png` 或 `000.png`）。
   千万别固定 2 位 —— 超过 100 帧时 `100.png` 会被字符串排序排到 `11.png` 前面，帧序全乱。

4. **跨动作尺度用 `scale` 补偿**：贴紧裁切抹掉了「猫在源视频里画了多大」的信息，
   姿势横向摊开的动作（伸懒腰、趴卧）会明显偏小。
   用 `check_action_scale.py` 按**屏幕像素面积**口径算倍数，填进 `CAT_ACTIONS[key].scale`。

5. **跳跃动作的垂直位移要保留**：见下一节第 1 条。

---

## 六、踩过的坑（都是真事，按重要度排）

### 1. 跳跃动作会被压成「原地蹬腿」

`process_walk.py` 默认**逐帧把脚底拉平到同一条锚线**——这对原地动作是对的，
但「开心跳」的垂直位移**就是动作本身**。逐帧拉平后，跳起来的那几帧会被按回地面，
出来是一只只蹬腿、不跳起来的猫。

**处理**：加 `--keep-v`。垂直方向改成「所有帧共用一个偏移」，把最低的脚底（着地那一刻）
对齐到锚线，空中的帧自然浮上去。实测 `hop` 脚底 143→114px、离地 29px 完整保留。

### 2. 素材底部被切掉一整条

源视频里猫脚底的 y 坐标可能很靠下（如 850，而画幅高 960）。若把锚线直接沿用源坐标，
画布却只有 `max_h*1.12` 高，猫下半身就会掉到画布外被齐平裁掉，抠图后留下一条横贯全幅的硬边。
**正确做法**是把锚线映射到「画布底部往上一丁点」，与源坐标脱钩。脚本里已修好。

### 3. 帧序错乱导致画面乱闪

`repack_loop.py` 早期用 `sorted(glob(...))` 做字符串排序，
`100.png` 排在 `11.png` 前面，动画每 11 帧跳一组，看上去就是不停闪。
数值指标却可能"看着还行"，极难从画面反推到原因。
现在改成**按文件名里的数字排序**，并且 `process_walk.py` 写帧名时就定宽补零。

### 4. 自动搜段可能给出「整段正放+倒放」的假循环

`doze` 就踩过：自动搜段挑出一个「自相似度只有 4.11」的短周期，又判定闭合差过大，
于是退回乒乓循环 —— 结果把**整条 97 帧视频正放+倒放了一遍**：8 秒、4.7MB，根本不是循环。

**处理**：先用 `_vsloop.py` 在源视频上搜出最优窗口，再用
`--range A B --no-search` 锁死。这三个动作最终的窗口与闭合比：

| 动作 | 源帧窗口 | 帧数 | 时长 | 闭合比 |
|---|---|---|---|---|
| doze 打瞌睡 | 60~86 | 27 | 1.12s | 0.45 |
| groom 舔毛洗脸 | 37~61 | 25 | 1.04s | 1.50 |
| hop 开心跳 | 19~41 | 23 | 0.96s | 0.25 |

### 5. 源视频有贴边帧，循环窗口要避开

`groom` 的源视频帧 36、66 尾巴尖贴到左边缘（最多 36 行 ≈ 体高 5%），抠图后是平直硬边。
其余 95 帧主体完整，所以把窗口取在 37~61 就完全绕开了。
**先跑 `check_cat_video.py` 找出这类帧，再用 `_vsloop.py --exclude` 排掉。**

### 6. 别把 `.md` 放在仓库根目录

`app/server.js` 的 `migrateLegacyLedgers()` 会把**项目根目录**（和 `data/` 根目录）的 `.md`
当成台账搬进 `data/<账号>/`。放子目录（如 `cat-media/README.md`）不受影响，
根目录只有 `README.md` 在白名单里。**新增文档请放子目录。**

### 7. 首帧不能用那张通用站立图

六个动作首帧的姿势必须各自贴合动作本身（详见 `猫猫动作提示词.md`）。
早期所有动作都拿站立图当首帧，模型被带跑：睡觉要从站姿一路演变成蜷缩，
动作又长又假，还容易被裁切。

### 8. 测试里的期望值别写死「动作个数」

`test_rotation.js` 原先在断言里写死了 `'idle,walk,idle,walk,idle,walk'`
和「连点 4 次回到起点」——那还是 ROTATION 只有两个动作时的语义。
后来往轮换里加动作，逻辑一直是好的，测试却开始报「顺序不对」，
容易误以为功能坏了。现在期望值改成从 `index.html` 里读 `ROTATION`，
**加动作后不必再动测试**。凡是「随动作数量变化」的断言，都该这样推导，不要抄字面值。

### 9. 测随机行为，得先把随机数接管过来

动作停留时长和「要不要换位置」都是随机的。这种逻辑如果直接在测试里跑，
只能写出"大概也许"的断言（甚至要跑很多次碰运气），失败也无法复现。

做法：把 `Math` 也当成依赖注入进去（`new Function(..., 'Math', ...)`），
传一个 `Object.create(Math)` 的替身、只把 `random` 换掉——
- 想要确定性：给个固定值（`() => 0.1` 必定换位置、`() => 0.9` 必定不换）
- 想验证「确实在随机」：给 mulberry32 之类的**可复现**伪随机，同一颗种子
  跑出同一条时间线，采样多次看是否出现多个不同取值

顺带一个坑：DOM 桩里的 `clearTimeout` 必须**真的能取消**定时器。
双击要靠 `clearTimeout` 掐掉「单击换动作」那个延时器；桩里如果写成空函数，
被取消的那次换动作还会照跑，断言就会莫名其妙地失败。

---

## 七、交付前质检清单

跑完这几条、数值都合格，才算可以交付：

| 检查 | 命令 | 合格线 |
|---|---|---|
| 源视频无裁切 | `python check_cat_video.py inbox/x.mp4` | 结论「通过」；贴边帧为 0 |
| 循环闭合 | `process_walk.py` 的输出 | 闭合比 ≤ 1.6 |
| 平直切边 | `process_walk.py` 的输出 | 「四边均为自然轮廓」 |
| 帧序 | `python check_action_flow.py ../app/assets/cat` | D2/D1 ≥ 1.45（实测正常值 1.56~1.86） |
| 屏幕尺度 | `python check_action_scale.py ../app/assets/cat idle` | 面积占比与待机差 ≤ 8%，否则填 scale |
| 每帧时长 | 见下 | 每帧均为 42ms（24fps），无 0 值 |
| 脚底锚点 | 见下 | 原地动作各帧底边 y 恒定 |

最后两条可以用 PIL 快速自查（PIL 读 duration 常返回 `None` 不可信，要看 WebP 文件本身）：

```python
import numpy as np
from PIL import Image
im = Image.open('processed/cat-hop.webp')
n = getattr(im, 'n_frames', 1)
for i in range(n):
    im.seek(i)
    a = np.asarray(im.convert('RGBA'))
    yy, _ = np.nonzero(a[:, :, 3] > 40)
    print(i, '顶边', yy.min(), '底边', yy.max())   # 原地动作底边应恒定
```

`_webp_timing.py`（本地诊断脚本，未入库）可以直接解析 WebP 的 ANMF 块读出真实每帧时长。

---

## 八、当前已上线的动作

| key | 中文 | 素材尺寸 | 帧数 | scale | 说明 |
|---|---|---|---|---|---|
| `idle` | 待机站立 | 108×108 | 24 | 1.0 | 基准动作，直接用参考图 |
| `walk` | 走路 | 100×96 | 25 | 1.0 | 唯一 `moves: true` |
| `hop` | 开心跳 | 151×144 | 23 | 1.15 | 唯一带垂直位移，靠 `--keep-v` |
| `stretch` | 伸懒腰 | 161×144 | 97 | 1.35 | 整段直放即闭环 |
| `groom` | 舔毛洗脸 | 153×143 | 25 | 1.14 | 窗口避开贴边帧 |
| `doze` | 打瞌睡 | 130×143 | 27 | 1.0 | 姿势方正，无需补偿 |
| `sleep` | 睡觉 | 259×143 | 28 | 1.28 | 趴卧最扁，需要补偿 |

轮换顺序（`ROTATION`）：`idle → walk → hop → stretch → groom → doze → sleep`

## 九、猫猫的交互与随机行为

设置面板里只有 **开关 / 大小 / 移动速度** 三项（猫猫脚本里对应 `cfg.w` / `cfg.tripSec`）。
动作节奏和位置**刻意不做成设置项**，都是随机的：

| 行为 | 现状 | 代码位置 |
|---|---|---|
| 每个动作停留多久 | 每轮从 **20~150 秒**随机掷（均值约 85 秒） | `SWITCH_MIN_SEC` / `SWITCH_MAX_SEC` |
| 换动作时是否换位置 | **50%** 概率「溜达到别处」，位置也随机 | `TELEPORT_P` / `teleport()` |
| 单击猫猫 | 立刻换下一个动作（并重新计时） | `onCatClick()` |
| 双击猫猫 | **随机换个位置**（不回出生点，动作保持不变） | `teleportRandom()` |
| 按住拖拽 | 拖到任意位置，松手后记住 | `onDown/onMove/onUp` |
| `cat.home()` | 回出生点。界面上已无入口，只留给控制台调试 | `goHome()` |

两个设计要点，改之前务必理解：

1. **换个地方发生在「切换动作的那一刻」**，不是趴着不动的时候凭空消失。
   猫是先淡出、再在新位置以新姿势出现，读起来是"溜达到别处去了"。
   正因为如此，才不需要按动作逐个 `roam: false`（那个字段已删除）。
2. **随机数可以外包给测试**。`rollSwitchSec()` 用的是全局 `Math.random`，
   而 `test_rotation.js` 会把 `Math` 整个注入成替身，
   于是"随机"在测试里变成确定性的 —— 详见第六节坑 9。
