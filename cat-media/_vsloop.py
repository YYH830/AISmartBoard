# -*- coding: utf-8 -*-
"""
在【源视频】上直接全量搜索最佳循环窗口，不用先跑抠图（省 6 分钟一轮）。

和 _bestloop.py 的区别：_bestloop.py 读的是抠好的成品帧（窗口必须限制在已选区段内），
本脚本直接读 mp4，用绿幕掩码算差异，因此：
  - 可以把【主体出框的帧】排除在外（那些帧抠图后会有平直硬边）；
  - 可以在整条视频上任意挑窗口，不受 process_walk 自动选段的影响。

评分口径与管线一致：ratio = 首尾闭合差 / 窗口内逐帧相邻差均值，≤1.6 视为无缝。

用法:
    python _vsloop.py inbox/groom.mp4 --exclude 36 66 --minlen 16 --top 14
    python _vsloop.py inbox/hop.mp4   --minlen 20 --top 14
"""
import os, sys, io
import numpy as np
import cv2

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.abspath(__file__))

argv = sys.argv[1:]
src = argv[0]
excl, minlen, top, hh, pingpong = [], 16, 14, 180, False
i = 1
while i < len(argv):
    if argv[i] == '--exclude':
        j = i + 1
        while j < len(argv) and not argv[j].startswith('--'):
            excl.append(int(argv[j])); j += 1
        i = j
    elif argv[i] == '--minlen':
        minlen, i = int(argv[i + 1]), i + 2
    elif argv[i] == '--top':
        top, i = int(argv[i + 1]), i + 2
    elif argv[i] == '--h':
        hh, i = int(argv[i + 1]), i + 2
    elif argv[i] == '--pingpong':
        pingpong, i = True, i + 1
    else:
        i += 1

cap = cv2.VideoCapture(os.path.join(ROOT, src))
frames, masks = [], []
while True:
    ok, bgr = cap.read()
    if not ok:
        break
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    scale = hh / rgb.shape[0]
    small = cv2.resize(rgb, (int(rgb.shape[1] * scale), hh), interpolation=cv2.INTER_AREA).astype(np.float32)
    ints = small.astype(np.int16)
    green = (ints[:, :, 1] - np.maximum(ints[:, :, 0], ints[:, :, 2]) > 40)
    frames.append(small)
    masks.append(~green)
cap.release()
N = len(frames)
print(f'{src}  {N} 帧（{hh}px 缩略）  排除帧: {excl if excl else "无"}')


def fdiff(k, j):
    m = masks[k] | masks[j]
    if m.sum() < 50:
        return 1e9
    return float(np.abs(frames[k] - frames[j]).mean(axis=2)[m].mean())


steps = np.array([fdiff(k, k + 1) for k in range(N - 1)])
print(f'  逐帧相邻差均值 {steps.mean():.2f}  max {steps.max():.2f}')

banned = set(excl)
cands = []
for A in range(N - 1):
    if A in banned:
        continue
    for B in range(A + minlen - 1, N):
        if any(b in banned for b in range(A, B + 1)):
            continue
        seg = steps[A:B]
        if len(seg) == 0:
            continue
        step = float(seg.mean())
        if step < 0.5:
            continue
        gap = 0.0 if pingpong else fdiff(A, B)
        cands.append((gap / step, gap, step, A, B, B - A + 1))

cands.sort()
print(f'\n  {"ratio":>6} {"gap":>7} {"step":>7} {"区间":>13} {"帧数":>5} {"秒":>6}')
for ratio, gap, step, A, B, L in cands[:top]:
    print(f'  {ratio:6.2f} {gap:7.2f} {step:7.2f} {A:5d}~{B:<5d} {L:5d} {L/24:6.2f}')

longs = [c for c in cands if c[5] >= max(minlen, 20)]
if longs:
    r, g, s, A, B, L = longs[0]
    print(f'\n  ≥20 帧的最优窗口: {A}~{B}（{L} 帧 {L/24:.2f}s）ratio {r:.2f} 逐帧差 {s:.2f}')
