# -*- coding: utf-8 -*-
"""
猫猫素材体检器（生成后先跑一遍，通过再交给我处理）

检查项：
  1) 规格：分辨率 / 帧率 / 帧数 / 时长
  2) 绿幕：背景色是否均匀纯绿（G-max(R,B) 越大越纯）
  3) 裁切：逐帧求主体包围盒，检查四周留白；贴边即判为「被裁切」
  4) 位移：主体包围盒中心的漂移量，判断是不是原地动作
输出：数值报告 + 抽帧拼图（人眼复核用）

用法：
    python check_cat_video.py inbox/standing.mp4
"""
import os, sys
import numpy as np
import av
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
VID = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'inbox', 'walking.mp4')

# Windows 控制台默认 GBK，中文会乱码；能重设就重设成 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# 判定阈值
SAFE_MARGIN_PCT = 5.0     # 四周留白至少要占画幅 5%，低于此值视为有裁切风险
GREEN_MIN       = 45      # G-max(R,B) 高于此值算绿幕背景
BG_PURE_MIN     = 70      # 背景纯绿得分下限
DRIFT_MAX_PCT   = 6.0     # 主体中心漂移上限（占画幅），超过说明不是原地动作

container = av.open(VID)
stream = container.streams.video[0]
W, H = stream.width, stream.height
FPS = float(stream.average_rate)
frames = [f.to_ndarray(format='rgb24') for f in container.decode(video=0)]
container.close()
N = len(frames)

print('=' * 66)
print(f'素材：{os.path.basename(VID)}')
print('=' * 66)
print(f'规格   : {W} x {H}  {FPS:.0f}fps  {N} 帧  时长 {N / FPS:.2f}s')

# ---------- 1) 绿幕纯净度 ----------
def corner_color(a):
    m = max(3, int(min(a.shape[:2]) * 0.02))
    strips = np.concatenate([
        a[:m, :].reshape(-1, 3), a[-m:, :].reshape(-1, 3),
        a[:, :m].reshape(-1, 3), a[:, -m:].reshape(-1, 3)]).astype(np.float32)
    med = np.median(strips, axis=0)
    return med, float(med[1] - max(med[0], med[2]))

bg_scores, bg_colors = [], []
for a in frames:
    med, gr = corner_color(a)
    bg_scores.append(gr); bg_colors.append(med)
bg = np.median(np.array(bg_colors), axis=0)
bg_gr = float(np.median(bg_scores))
hex_bg = '#%02X%02X%02X' % tuple(bg.round(0).astype(int))
# 纯绿帧占比：背景得分达标的帧
pure_ratio = sum(1 for s in bg_scores if s >= BG_PURE_MIN) / max(1, N)
ok_bg = bg_gr >= BG_PURE_MIN
print(f'绿幕   : 背景 {bg.round(0).astype(int)} {hex_bg}  绿优势 {bg_gr:.0f}  '
      f'纯绿帧 {pure_ratio * 100:.0f}%  ->  {"OK" if ok_bg else "不合格（绿幕不纯）"}')

# ---------- 2) 裁切 & 位移 ----------
# 只在「纯绿幕帧」上评估留白：首尾白场淡入淡出帧整幅都不是绿色，
# 若一并纳入会把整幅画面误判成主体，从而报出假的「贴边」。
margins, centers, sizes, skipped = [], [], [], 0
for a, gr in zip(frames, bg_scores):
    if gr < BG_PURE_MIN:                       # 非纯绿帧（白场/过渡）不参与判定
        skipped += 1
        continue
    af = a.astype(np.float32)
    gn = af[:, :, 1] - np.maximum(af[:, :, 0], af[:, :, 2])
    ys, xs = np.where(gn < GREEN_MIN)          # 非绿 = 主体
    if len(ys) == 0:
        skipped += 1
        continue
    # 主体几乎铺满整幅，说明这一帧底色异常，跳过以免污染判定
    if (xs.max() - xs.min() + 1) * (ys.max() - ys.min() + 1) > W * H * 0.95:
        skipped += 1
        continue
    margins.append(dict(l=int(xs.min()), r=int(W - 1 - xs.max()),
                        t=int(ys.min()), b=int(H - 1 - ys.max())))
    centers.append((float((xs.min() + xs.max()) / 2), float((ys.min() + ys.max()) / 2)))
    sizes.append((int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)))

if not margins:
    print('主体   : 有效绿幕帧中未检测到主体，退出'); sys.exit(1)
if skipped:
    print(f'         （{skipped} 帧非纯绿/异常已跳过：白场淡入淡出等）')

min_margin = min(min(m.values()) for m in margins)
min_pct = min_margin / W * 100
# 找出边距最紧的一侧（可能有多个）
tight = [side for side, cn in (('左', 'l'), ('右', 'r'), ('上', 't'), ('下', 'b'))
         if min(m[cn] for m in margins) == min_margin]
clipped = [i for i, m in enumerate(margins) if min(m.values()) <= 1]

print(f'留白   : 四周最小值 {min_margin}px（画幅 {min_pct:.1f}%，最紧在 {"／".join(tight)} 侧）')
# 硬标准：只要有任何一帧主体顶到画面边缘，就是被裁切，抠图后会出现平直断口
ok_margin = len(clipped) == 0
if ok_margin:
    note = 'OK' if min_pct >= SAFE_MARGIN_PCT else f'OK，但边距偏紧（建议 ≥{SAFE_MARGIN_PCT:.0f}%）'
    print(f'         -> {note}，无贴边')
else:
    print(f'         -> 不合格（{len(clipped)} 帧贴边，主体被裁切）')

cs = np.array(centers)
drift_x = (cs[:, 0].max() - cs[:, 0].min()) / W * 100
drift_y = (cs[:, 1].max() - cs[:, 1].min()) / H * 100
print(f'位移   : 主体中心漂移 X {drift_x:.1f}%  Y {drift_y:.1f}%  '
      f'-> {"原地动作 OK" if max(drift_x, drift_y) <= DRIFT_MAX_PCT else "有移动（若要原地待机需重做）"}')

# ---------- 3) 结论 ----------
print('-' * 66)
verdict = ok_bg and ok_margin
print('结论   : ' + ('通过，可以交付处理' if verdict else '未通过，建议重新生成'))
if not ok_bg:
    print('   - 绿幕不够纯净：确保背景是均匀纯色绿，无渐变 / 阴影 / 地面')
if not ok_margin:
    print('   - 主体被裁切：缩小主体或后移机位，四周留出至少 10% 空白')
if max(drift_x, drift_y) > DRIFT_MAX_PCT:
    print('   - 主体在画幅内移动：待机类动作应原地不动，仅做身体/尾巴起伏')
print('=' * 66)

# ---------- 4) 抽帧拼图（人眼复核）----------
PICK, COL, CELL = 12, 4, 300
idxs = np.linspace(0, N - 1, PICK).round().astype(int)
rows_n = (PICK + COL - 1) // COL
sh = Image.new('RGB', (COL * CELL + (COL + 1) * 8, rows_n * (CELL + 22) + 8), (238, 236, 233))
dr = ImageDraw.Draw(sh)
for k, i in enumerate(idxs):
    im = Image.fromarray(frames[i]).resize((CELL, CELL), Image.LANCZOS)
    # 画安全边距参考框，越框即被裁切
    d2 = ImageDraw.Draw(im)
    inset = int(CELL * SAFE_MARGIN_PCT / 100)
    d2.rectangle([inset, inset, CELL - inset, CELL - inset], outline=(255, 80, 80), width=2)
    cx = 8 + (k % COL) * (CELL + 8)
    cy = 8 + (k // COL) * (CELL + 22)
    sh.paste(im, (cx, cy))
    dr.text((cx + 3, cy + CELL + 4), f'frame {i} ({i / FPS:.2f}s)', fill=(50, 42, 36))
out = os.path.join(ROOT, 'check-sheet.png')
sh.save(out)
print(f'拼图（红框=安全边距参考，主体不得越框）: {out}')
