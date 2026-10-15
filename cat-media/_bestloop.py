# -*- coding: utf-8 -*-
"""
在已抠好的帧目录里，全量搜索「最适合做循环的窗口」。

评分标准（沿用管线里的口径）：
    ratio = 首尾闭合差 gap(A,B) / 窗口内逐帧相邻差均值 step
ratio 越小说明"尾帧越像首帧、且中间动得够明显"—— 即回接时不跳。
ratio ≤ 1.6 视为无缝。

为什么不能只靠"自相似周期"：周期搜索假设动作严格等周期，
但生成模型给的动作往往是「点头、点头、忽然惊醒、再点头」这种不规则节律，
周期法会挑出一个根本不闭合的段。直接全量枚举窗口反而更快也更准。

用法:
    python _bestloop.py cat-doze-frames [--minlen 16] [--top 15] [--pingpong]
    --pingpong 时退化为「只挑运动量足够的一段」，因为乒乓天生闭合
"""
import os, sys, io, glob, re
import numpy as np
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.abspath(__file__))

argv = sys.argv[1:]
dname = argv[0]
minlen, top, pp, only = 16, 15, False, 0
i = 1
while i < len(argv):
    if argv[i] == '--minlen':
        minlen, i = int(argv[i + 1]), i + 2
    elif argv[i] == '--top':
        top, i = int(argv[i + 1]), i + 2
    elif argv[i] == '--only':
        # 只分析前 N 帧。素材若是乒乓循环，后半段是倒放镜像，
        # 会和前半段产生大量「gap=0」的假匹配，必须切掉。
        only, i = int(argv[i + 1]), i + 2
    elif argv[i] == '--pingpong':
        pp, i = True, i + 1
    else:
        i += 1

d = os.path.join(ROOT, 'processed', dname)
files = sorted(glob.glob(os.path.join(d, '*.png')),
               key=lambda p: int(re.search(r'(\d+)', os.path.basename(p)).group(1)))
if only:
    files = files[:only]
# 缩一半算差，噪声更少也更快
ims = [np.asarray(Image.open(f).convert('RGBA').resize(
    (max(1, Image.open(f).width // 2), max(1, Image.open(f).height // 2))), dtype=np.float32) for f in files]
N = len(ims)
print(f'[{dname}] {N} 帧，{files[0].split(os.sep)[-1]} ~ {files[-1].split(os.sep)[-1]}')


def fdiff(a, b):
    m = (a[:, :, 3] > 30) | (b[:, :, 3] > 30)
    if m.sum() < 50:
        return 1e9
    return float(np.abs(a[:, :, :3] - b[:, :, :3]).mean(axis=2)[m].mean())


steps = np.array([fdiff(ims[k], ims[k + 1]) for k in range(N - 1)])
pre = np.concatenate([[0.0], np.cumsum(steps)])   # pre[k] = 前 k 个相邻差之和

cands = []
for A in range(N - 1):
    for B in range(A + minlen - 1, N):
        seg = steps[A:B]
        if len(seg) == 0:
            continue
        step = float(seg.mean())
        if step < 0.5:            # 几乎静止的窗口没意义
            continue
        gap = fdiff(ims[A], ims[B])
        cands.append((gap / step, gap, step, A, B, B - A + 1))

cands.sort()
print(f'\n  逐帧相邻差均值 {steps.mean():.2f}   max {steps.max():.2f}')
print(f'\n  {"ratio":>6} {"gap":>7} {"step":>7} {"区间":>12} {"秒":>6}')
for ratio, gap, step, A, B, L in cands[:top]:
    print(f'  {ratio:6.2f} {gap:7.2f} {step:7.2f} {A:5d}~{B:<5d} {L/24:6.2f}')

# 只看「够长」的窗口里最优的
longs = [c for c in cands if c[5] >= max(minlen, 20)]
if longs:
    r, g, s, A, B, L = longs[0]
    print(f'\n  ≥20 帧的最优窗口: {A}~{B}（{L} 帧 {L/24:.2f}s）ratio {r:.2f}')
