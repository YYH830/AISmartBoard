# -*- coding: utf-8 -*-
"""
绿幕视频 → 透明循环动画
流程：
  1. 解码，剔除首尾白场
  2. 绿幕抠图（色度键）+ 去绿边（despill）
  3. 自动搜索最佳循环段（遍历「起点 × 周期」，取首尾最吻合的一段）
  4. 按质心对齐，消除帧间抖动
  5. 输出透明动画（WebP / APNG / GIF）+ 各尺寸预览 + 质检图
"""
import os, sys, json
import numpy as np
import av
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(ROOT, 'inbox')
OUTDIR = os.path.join(ROOT, 'processed')
os.makedirs(OUTDIR, exist_ok=True)

# ---- 命令行参数 ----
#   python process_walk.py 视频路径 [选项]
#   --out 名       输出名（决定 processed/<名>.webp）
#   --range A B    只在指定帧区间做动画（默认自动挑最长可用区段）
#   --no-search    不自动搜循环段，直接把 --range 指定的区间整段当循环用。
#                  配合 _vsloop.py 在源视频上搜出最优窗口后，用这个锁死窗口。
#   --allow-clip   允许包含主体出框的帧（默认排除；出框帧抠图后会有平直硬边）
#   --pingpong     强制乒乓循环（正放+倒放）；默认先试自相似循环，质量不足时自动改乒乓
#   --tight        贴紧猫体裁掉多余留白（与已有素材的打包约定一致）
#   --height N     输出素材的高度（像素），默认 160
#   --stride N     每隔 N 帧取一帧（减小体积），默认 1
#   --keep-v       保留垂直位移（跳跃类动作用）。默认逐帧把脚底拉平到同一锚线，
#                  对「开心跳」这种靠垂直位移表达的动作会把跳跃压平，必须加此项。
#   --dump-all     额外把「对齐后、未选循环段」的全部帧存到 processed/<名>-all/
#                  （帧号=源视频帧号），便于用 _bestloop.py 事后重挑循环窗口。
#   --lossy Q      有损 webp 质量（如 88）；默认无损
argv = sys.argv[1:]
vid, out_name, rng, allow_clip = None, None, None, False
pingpong, tight, target_h, stride, lossy, keep_v = False, False, 160, 1, None, False
dump_all, no_search = False, False
i = 0
while i < len(argv):
    a = argv[i]
    if a == '--out':
        out_name, i = argv[i + 1], i + 2
    elif a == '--range':
        rng, i = (int(argv[i + 1]), int(argv[i + 2])), i + 3
    elif a == '--allow-clip':
        allow_clip, i = True, i + 1
    elif a == '--pingpong':
        pingpong, i = True, i + 1
    elif a == '--tight':
        tight, i = True, i + 1
    elif a == '--keep-v':
        keep_v, i = True, i + 1
    elif a == '--dump-all':
        dump_all, i = True, i + 1
    elif a == '--no-search':
        no_search, i = True, i + 1
    elif a == '--height':
        target_h, i = int(argv[i + 1]), i + 2
    elif a == '--stride':
        stride, i = max(1, int(argv[i + 1])), i + 2
    elif a == '--lossy':
        lossy, i = int(argv[i + 1]), i + 2
    else:
        vid, i = a, i + 1

VID = vid or os.path.join(INBOX, 'walking.mp4')
NAME = out_name or os.path.splitext(os.path.basename(VID))[0]

# ============ 1) 解码 ============
container = av.open(VID)
raw = [f.to_ndarray(format='rgb24') for f in container.decode(video=0)]
container.close()
N = len(raw)
print(f'[{NAME}] 解码 {N} 帧')

# ============ 2) 逐帧体检：绿幕是否合格 + 主体是否出框 ============
def corner_color(a):
    h, w = a.shape[:2]
    m = max(3, int(min(h, w) * 0.02))
    strips = np.concatenate([
        a[:m, :].reshape(-1, 3), a[-m:, :].reshape(-1, 3),
        a[:, :m].reshape(-1, 3), a[:, -m:].reshape(-1, 3)], axis=0).astype(np.float32)
    med = np.median(strips, axis=0)
    return med, float(med[1] - max(med[0], med[2]))

def subject_margins(a, green_adv=45):
    """主体四边留白 (左, 右, 上, 下)；无主体返回 None。
    留白 <= 1 说明主体贴到画面边缘：这部分像素已被切掉、无法补救，
    抠图后会留下平直的硬边（正常轮廓是圆润的毛发边缘），所以默认要排除这类帧。"""
    af = a.astype(np.float32)
    gn = af[:, :, 1] - np.maximum(af[:, :, 0], af[:, :, 2])
    ys, xs = np.where(gn < green_adv)
    if len(ys) == 0:
        return None
    h, w = a.shape[:2]
    return (int(xs.min()), int(w - 1 - xs.max()), int(ys.min()), int(h - 1 - ys.max()))

# 逐帧判定：绿幕合格（非白场/过渡）且主体不出框
frame_ok, clipped_cnt = [], 0
for a in raw:
    med, gr = corner_color(a)
    if gr <= 45:                       # 白场 / 淡入淡出帧
        frame_ok.append(False)
        continue
    mg = subject_margins(a)
    ok = bool(mg) and min(mg) > 1
    if not ok:
        clipped_cnt += 1
    frame_ok.append(ok)

if not any(frame_ok):
    print('未找到「绿幕合格且主体不出框」的帧，退出'); sys.exit(1)

if rng:
    SEG_A, SEG_B = rng
    SEG_A, SEG_B = max(0, SEG_A), min(N - 1, SEG_B)
    bad = [i for i in range(SEG_A, SEG_B + 1) if not frame_ok[i]]
    print(f'  指定区间: 帧 {SEG_A} ~ {SEG_B}  ({SEG_B - SEG_A + 1} 帧)')
    if bad and not allow_clip:
        print(f'  警告: 区间内有 {len(bad)} 帧绿幕不合格或主体出框（如帧 {bad[:8]}），'
              f'抠图后会有硬边；加 --allow-clip 可强制继续')
        sys.exit(1)
    if bad:
        print(f'  注意: 区间内有 {len(bad)} 帧出框，已按 --allow-clip 继续，成品会有硬边')
else:
    # 找最长的「连续可用」区段：这样产出的动画天然不含被裁切的部位
    runs, s = [], None
    for i in range(N + 1):
        on = i < N and frame_ok[i]
        if on and s is None:
            s = i
        elif not on and s is not None:
            runs.append((s, i - 1)); s = None
    runs.sort(key=lambda r: r[1] - r[0], reverse=True)
    SEG_A, SEG_B = runs[0]
    print(f'  自动选定区段: 帧 {SEG_A} ~ {SEG_B}  ({SEG_B - SEG_A + 1} 帧，'
          f'{(SEG_B - SEG_A + 1) / 24.0:.2f} 秒)')
    if clipped_cnt:
        print(f'  已排除 {clipped_cnt}/{N} 帧（主体出框或绿幕不合格）')
    if len(runs) > 1:
        print('  其余候选区段: ' + '、'.join(f'{a}~{b}' for a, b in runs[1:4]))

BG = corner_color(raw[(SEG_A + SEG_B) // 2])[0]
print(f'  背景色: {BG.round(0).astype(int)}')

# ============ 3) 抠图 + 去绿边 ============
def key_frame(a, bg, lo=12, hi=58):
    """色度键：以 G - max(R,B) 为绿色判别量做软边；再做 despill 去绿边"""
    af = a.astype(np.float32)
    R, G, B = af[:, :, 0], af[:, :, 1], af[:, :, 2]
    gness = G - np.maximum(R, B)
    # 背景绿优势 ≈ bg[1]-max(bg[0],bg[2])；把 [lo,hi] 映射到 alpha [1,0]
    alpha = np.clip((hi - gness) / (hi - lo), 0.0, 1.0)
    # 提高对比：中段压得更干紧一些，避免半透明残留
    alpha = alpha ** 0.75
    # despill：把绿通道压到不超过 R/B 的最大值，去掉边缘绿边
    despilled = af.copy()
    over = G - np.maximum(R, B)
    mask = over > 0
    despilled[:, :, 1] = np.where(mask, np.maximum(R, B), G)
    # 只保留猫的连通区域附近（去掉零星噪点/背景反光）
    out = np.dstack([despilled, alpha * 255]).astype(np.uint8)
    return out

def largest_component_mask(alpha, thr=90):
    """简易连通域：用形态学闭运算 + 保留最大块，压掉零星反光点"""
    m = alpha > thr
    # 闭运算：先膨胀后腐蚀（用位移近似）
    def dilate(x, r=2):
        y = x.copy()
        for _ in range(r):
            p = np.pad(y, 1, mode='constant')
            y = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | y)
        return y
    def erode(x, r=2):
        y = x.copy()
        for _ in range(r):
            p = np.pad(y, 1, mode='constant', constant_values=True)
            y = (p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:] & y)
        return y
    closed = erode(dilate(m, 3), 3)
    # 从画面中心开始，保留最大的连通块
    lbl = np.zeros(closed.shape, dtype=np.int32)
    cur = 0
    h, w = closed.shape
    ys, xs = np.where(closed)
    if len(ys) == 0:
        return m
    for y0, x0 in zip(ys[::37], xs[::37]):   # 稀疏种子，够用
        if lbl[y0, x0]:
            continue
        cur += 1
        stack = [(y0, x0)]
        lbl[y0, x0] = cur
        while stack:
            cy, cx = stack.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and closed[ny, nx] and not lbl[ny, nx]:
                    lbl[ny, nx] = cur
                    stack.append((ny, nx))
    if cur == 0:
        return m
    sizes = np.bincount(lbl.ravel())
    sizes[0] = 0
    best = sizes.argmax()
    keep = dilate(lbl == best, 2)
    return m & keep

print('  抠图中…')
keyed = []
for i in range(SEG_A, SEG_B + 1):
    a = raw[i]
    out = key_frame(a, BG)
    mask = largest_component_mask(out[:, :, 3])
    out[:, :, 3] = np.where(mask, out[:, :, 3], 0)
    keyed.append(out)
print(f'  完成 {len(keyed)} 帧')

# ============ 4) 对齐 ============
def stats(rgba):
    al = rgba[:, :, 3].astype(np.float32)
    tot = al.sum()
    if tot < 1:
        return None
    ys, xs = np.mgrid[0:al.shape[0], 0:al.shape[1]]
    cx = (xs * al).sum() / tot
    cy = (ys * al).sum() / tot
    m = al > 100
    yy, xx = np.where(m)
    return dict(cx=cx, cy=cy, x0=xx.min(), x1=xx.max(), y0=yy.min(), y1=yy.max(),
                w=xx.max() - xx.min() + 1, h=yy.max() - yy.min() + 1)

st = [stats(k) for k in keyed]
valid = [s for s in st if s]
print(f'  猫体尺寸中位: {int(np.median([s["w"] for s in valid]))} x {int(np.median([s["h"] for s in valid]))}')

# 统一画布：以「脚底」和「水平质心」为锚，让猫站在原地迈腿
# 注意：锚线必须落在画布【内部】，不能直接沿用源坐标里的 ref_bottom。
# 源视频里猫脚底的 y 值可能很靠下（例如 850，而画幅高 960）；若把锚线直接
# 放在画布 y=850、画布却只有 max_h*1.12 高（例如 575），猫的下半身就会掉到
# 画布外被齐平裁掉 —— 抠图后留下一条横贯整幅的硬边（肉眼像被切了一刀）。
# 正确做法：把锚线映射到「画布底部往上一丁点」，让画布自己决定坐标，与源坐标脱钩。
ref_bottom = int(np.median([s['y1'] for s in valid]))
ref_cx = float(np.median([s['cx'] for s in valid]))
max_w = int(max(s['w'] for s in valid))
dy_const = None
if keep_v:
    # 跳跃类动作（开心跳）：垂直位移【就是动作本身】。
    # 若像其它动作那样逐帧把脚底拉平到同一条锚线，跳起来的那几帧会被按回地面，
    # 结果是一只「只蹬腿、不跳起来」的猫 —— 动作直接废掉。
    # 所以垂直方向改用【所有帧共用一个偏移】：把整段里最低的脚底（着地那一刻）
    # 对齐到锚线，空中的帧自然就浮上去，跳跃高度真实保留。
    # 横向仍逐帧对齐（见下面的 dx），用来消除模型造成的水平漂移。
    ground   = int(max(s['y1'] for s in valid))     # 最低的脚底 = 着地线
    top_most = int(min(s['y0'] for s in valid))     # 整段里的最高点
    span     = max(1, ground - top_most)            # 垂直总跨度（含跳跃高度）
    CW = int(max_w * 1.20)
    CH = int(span * 1.12)
    anchor_y = CH - max(2, int(span * 0.06))
    dy_const = anchor_y - ground
    print(f'  统一画布: {CW} x {CH}（跳跃模式：着地线锚在 y={anchor_y}，垂直跨度 {span}）')
else:
    max_h = int(max(s['h'] for s in valid))
    CW = int(max_w * 1.20)
    CH = int(max_h * 1.12)
    anchor_y = CH - max(2, int(max_h * 0.06))   # 脚底锚线：离画布底留 6%，保证整只猫都在画布内
    print(f'  统一画布: {CW} x {CH}（脚底锚线 y={anchor_y}）')

aligned = []
for k, s in zip(keyed, st):
    if s is None:
        continue
    cv = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    img = Image.fromarray(k, 'RGBA')
    # 裁掉整幅里的猫区域再贴，效率更高也更准
    dx = int(round(CW / 2 - s['cx']))
    dy = dy_const if keep_v else (anchor_y - s['y1'])
    cv.paste(img, (dx, dy), img)
    aligned.append(np.asarray(cv).astype(np.uint8))
print(f'  对齐后 {len(aligned)} 帧')

# 把「对齐后、还没选循环段」的全部帧另存一份（processed/<名>-all/），帧号与源视频一一对应。
# 用途：正式输出的 <名>-frames/ 只含选中的循环段（乒乓时还夹着倒放镜像），帧号已经错位，
# 想事后用 _bestloop.py 全量搜窗口就没法对上号了。有了这份就随时能重挑段。
if dump_all:
    ad = os.path.join(OUTDIR, NAME + '-all')
    os.makedirs(ad, exist_ok=True)
    _aw = max(2, len(str(len(aligned) - 1)))
    for i, f in enumerate(aligned):
        Image.fromarray(f, 'RGBA').save(os.path.join(ad, f'{i:0{_aw}d}.png'))
    print(f'  对齐帧全量导出: {NAME}-all/（{len(aligned)} 帧，帧号=源帧号）')

# ============ 5) 选取循环段 ============
# 两种循环方式：
#   loop     自相似循环 —— 找一段「首尾姿势吻合」的区间
#   pingpong 乒乓循环   —— 正放一段再倒放，闭合处天然是相邻帧，必定无缝
# 判断流畅度的正确指标不是「自相似度」，而是「首尾闭合差」和「逐帧相邻差」的比值：
# 闭合差 ≈ 相邻差 → 回接时看不出接缝；闭合差明显更大 → 播放到末尾会「跳一下」。
def fdiff(a, b):
    m = (a[:, :, 3] > 30) | (b[:, :, 3] > 30)
    if m.sum() < 50:
        return 1e9
    # 必须转 float32 再相减：uint8 相减会溢出回绕，算出无意义的大数值
    d = np.abs(a[:, :, :3].astype(np.float32) - b[:, :, :3].astype(np.float32))
    return float(d.mean(axis=2)[m].mean())

def seq_quality(seq):
    """返回 (逐帧相邻差均值, 首尾闭合差)"""
    if len(seq) < 2:
        return 0.0, 0.0
    steps = [fdiff(seq[i], seq[i + 1]) for i in range(len(seq) - 1)]
    return float(np.mean(steps)), fdiff(seq[-1], seq[0])

def boomerang(seq):
    """乒乓：正放 + 倒放（去掉两端重复帧），闭合处即原来的相邻帧"""
    return list(seq) + list(seq[-2:0:-1]) if len(seq) > 2 else list(seq)

print('  选取循环段…')
small = [np.asarray(Image.fromarray(f, 'RGBA').resize((CW // 2, CH // 2), Image.LANCZOS)).astype(np.float32)
         for f in aligned]
M = len(small)

if no_search:
    # 直接用命令行指定窗口成片，不做自动搜段。
    # 为何需要：自动搜段是在「已截好的区段」内部找最短的自相似周期，
    # 它可能挑出一个更短、闭合更差的子段，甚至判成乒乓循环把整段来回放两遍。
    # 先用 _vsloop.py 在源视频上全量搜过最优窗口时，就应该用本开关锁死。
    loop, how = list(aligned), f'指定窗口（源帧 {SEG_A}~{SEG_B}，不搜段）'
elif pingpong:
    loop = boomerang(aligned)
    how = '乒乓循环（指定）'
else:
    best = None
    for p in range(8, min(61, M // 2 + 1)):
        for s0 in range(0, M - 2 * p + 1, 1):
            # 该周期在 [s0, s0+2p) 内的平均自相似度
            d = np.mean([fdiff(small[s0 + k], small[s0 + k + p]) for k in range(0, p, max(1, p // 8))])
            if best is None or d < best[0]:
                best = (d, s0, p)
    if best is None:
        print('  未找到合适周期，改用整段')
        loop, how = list(aligned), '整段（未找到周期）'
    else:
        score, s0, p = best
        loop = list(aligned[s0:s0 + p])
        how = f'自相似循环（起点 {s0}，周期 {p} 帧 {p / 24.0:.2f} 秒，自相似度 {score:.2f}）'

stepd, gapd = seq_quality(loop)
# 自相似循环若闭合差远大于相邻差，说明回接时会跳；此时自动改乒乓（无损画质、必定无缝）
if no_search and gapd > stepd * 1.6:
    print(f'  提示: 指定窗口的闭合差 {gapd:.1f} 偏大于逐帧相邻差 {stepd:.1f}，'
          f'回接时可能顿一下（确认过画面可忽略，或改用 --pingpong）')
elif not pingpong and gapd > stepd * 1.6:
    print(f'  {how} 的闭合差 {gapd:.1f} 远大于逐帧相邻差 {stepd:.1f}（会跳一下）→ 自动改用乒乓循环')
    loop, how = boomerang(aligned), '乒乓循环（自动）'
    stepd, gapd = seq_quality(loop)
print(f'  采用 {how}: {len(loop)} 帧，{len(loop) / 24.0:.2f} 秒')
print(f'  循环质量: 逐帧相邻差 {stepd:.2f}，首尾闭合差 {gapd:.2f} '
      f'(比值 {gapd / max(1e-6, stepd):.2f}，≤1.6 视为无缝)')

# ---- 抽帧（可选）：待机类动作幅度小，隔帧取一帧肉眼看不出差别，体积却能减半 ----
if stride > 1:
    loop = loop[::stride]
    print(f'  每隔 {stride} 帧取一帧 → {len(loop)} 帧')

# ============ 6) 输出 ============
print(f'  缩放中（目标高度 {target_h}px）…')
final = []
for f in loop:
    im = Image.fromarray(f, 'RGBA')
    im = im.resize((max(1, int(im.width * target_h / im.height)), target_h), Image.LANCZOS)
    final.append(im)

# 贴紧猫体：裁掉并集外接框之外的留白。
# 这一步直接决定素材里「猫占画幅的比例」，也就决定应用里的实际显示大小 ——
# 必须与已有素材（cat-walk 是 100x96 的贴紧裁切）一致，否则切换动作时猫会突然变大变小。
if tight:
    xs, ys = [], []
    for im in final:
        a = np.asarray(im)
        yy, xx = np.where(a[:, :, 3] > 20)
        if len(yy) == 0:
            continue
        xs.append((xx.min(), xx.max())); ys.append((yy.min(), yy.max()))
    if xs:
        x0, x1 = min(v[0] for v in xs), max(v[1] for v in xs)
        y0, y1 = min(v[0] for v in ys), max(v[1] for v in ys)
        print(f'  贴紧猫体: {final[0].size} → {(x1 - x0 + 1, y1 - y0 + 1)}')
        final = [im.crop((x0, y0, x1 + 1, y1 + 1)) for im in final]

fd = os.path.join(OUTDIR, NAME + '-frames')
os.makedirs(fd, exist_ok=True)
# 帧名定宽补零（按总帧数决定位数）：这样字符串排序 == 数字排序。
# 若固定用 2 位，超过 100 帧（乒乓循环很容易超）就会混进三位数，
# 别人拿 glob+sorted() 读帧时 '100.png' 会排到 '11.png' 前面、帧序全乱，
# 动画就会乱闪 —— 这个坑非常难从画面反推，索性从写出的这一刻就避免。
_name_w = max(2, len(str(len(final) - 1)))
for i, im in enumerate(final):
    im.save(os.path.join(fd, f'{i:0{_name_w}d}.png'))

# 每帧显示时长：抽帧后要相应延长，否则动画会变快
duration = int(round(1000 / 24 * stride))
webp_kw = dict(lossless=False, quality=lossy, method=6) if lossy else dict(lossless=True)
webp = os.path.join(OUTDIR, f'{NAME}.webp')
gif = os.path.join(OUTDIR, f'{NAME}.gif')
final[0].save(webp, save_all=True, append_images=final[1:], duration=duration, loop=0, **webp_kw)
final[0].save(gif, save_all=True, append_images=final[1:], duration=duration, loop=0, transparency=0)
try:
    final[0].save(os.path.join(OUTDIR, f'{NAME}.png'), save_all=True,
                  append_images=final[1:], duration=duration, loop=0)
except Exception as e:
    print('  APNG 导出跳过:', e)

# 质检图：浅底 / 深底 / 帧条
gap, margin, lab = 8, 14, 24
W = margin * 2 + sum(f.width for f in final) + gap * (len(final) - 1)
sh = Image.new('RGB', (W, 2 * (final[0].height + lab) + 16 + margin * 2), (150, 145, 138))
dr = ImageDraw.Draw(sh)
y = margin
for bg, label in [((253, 251, 248), '浅色背景（模拟日历）'), ((22, 27, 40), '深色背景（查绿边残留）')]:
    band = Image.new('RGB', (W - margin * 2, final[0].height + lab), bg)
    x = 0
    for f in final:
        band.paste(f, (x, 0), f)
        x += f.width + gap
    sh.paste(band, (margin, y))
    dr.text((margin + 3, y + final[0].height + 5), label, fill=(60, 50, 42))
    y += final[0].height + lab + 16
sh.save(os.path.join(ROOT, f'{NAME}-check.png'))

meta = dict(source=os.path.basename(VID), total_frames=N, usable=(SEG_A, SEG_B),
            loop_mode=how, frames=len(final), stride=stride,
            frame_size=[final[0].width, final[0].height], duration_ms=duration,
            loop_step_diff=round(stepd, 2), loop_gap_diff=round(gapd, 2),
            bg_color=[float(v) for v in BG])
with open(os.path.join(OUTDIR, f'{NAME}.json'), 'w', encoding='utf-8') as fp:
    json.dump(meta, fp, ensure_ascii=False, indent=2)

size_kb = os.path.getsize(webp) / 1024
print(f'\n输出目录: {OUTDIR}')
print(f'  {NAME}.webp / {NAME}.gif / {NAME}-frames/ (共 {len(final)} 帧, {final[0].size}, {size_kb:.0f} KB)')
print(f'  质检图: {NAME}-check.png')

# ============ 7) 自动质检：平直切边 ============
# 正常抠图后，猫体四边都是圆润的毛发轮廓：最底一行只有爪子/腹部着地的那几个
# 像素是不透明的。若某条边上「不透明像素」几乎横贯整幅，说明猫被画布边界切了，
# 抠图后留下一条平直硬边（肉眼像被切了一刀），必须修画布重做，不能就这么上线。
# 这里就是漏检过这个问题的哨兵 —— 宁可多打印几行，也别再让切过的素材溜出去。
alphas = [np.asarray(f)[:, :, 3] > 128 for f in final]
fw, fh = final[0].size
borders = {
    '底边': [int(a[-1, :].sum()) for a in alphas],
    '顶边': [int(a[0, :].sum()) for a in alphas],
    '左边': [int(a[:, 0].sum()) for a in alphas],
    '右边': [int(a[:, -1].sum()) for a in alphas],
}
warn = []
for name, cnt in borders.items():
    span = fw if name in ('底边', '顶边') else fh
    worst = max(cnt)
    cov = worst / span
    if cov >= 0.55:
        warn.append(f'    {name}: 最大覆盖 {cov*100:.0f}%（{worst}/{span} 像素横贯）')
print('  切边质检: ' + ('通过，四边均为自然轮廓' if not warn else '发现平直切边！'))
if warn:
    print('  以下边被画布切掉，抠图后会有硬边，需要修正对齐画布后重跑：')
    print('\n'.join(warn))
