# -*- coding: utf-8 -*-
"""
直接量源视频里「主体包围盒」随时间的轨迹，用来判断动作的节律。
  - top  = 包围盒顶边 y0：头部上下起伏时最敏感（打瞌睡看它）
  - bot  = 包围盒底边 y1：脚底/着地线（跳跃时看它）
  - cx   = 水平质心：横向漂移
输出：逐帧数值 + 极值点（峰/谷）清单，方便数出「一个动作几帧」。
用法: python _headtrace.py inbox/doze.mp4 [起始] [结束] [输出图]
"""
import os, sys, io
import numpy as np
import cv2
from PIL import Image, ImageDraw

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.abspath(__file__))

src = sys.argv[1]
lo = int(sys.argv[2]) if len(sys.argv) > 2 else 0
hi = int(sys.argv[3]) if len(sys.argv) > 3 else 10 ** 9
png = sys.argv[4] if len(sys.argv) > 4 else None

cap = cv2.VideoCapture(os.path.join(ROOT, src))
rows = []
idx = 0
while True:
    ok, bgr = cap.read()
    if not ok:
        break
    if lo <= idx <= hi:
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.int16)
        # 绿幕判定：G 明显大于 R 和 B
        green = (rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2]) > 40)
        sub = ~green
        # 只保留足够大的连通块，避免噪点干扰
        n, lab, stats, _ = cv2.connectedComponentsWithStats(sub.astype(np.uint8), 8)
        if n > 1:
            big = 1 + int(np.argmax(stats[1:, 4]))
            m = lab == big
        else:
            m = sub
        ys, xs = np.nonzero(m)
        rows.append((idx, int(ys.min()), int(ys.max()), float(xs.mean()), float(ys.mean()), int(xs.min()), int(xs.max())))
    idx += 1
cap.release()

if not rows:
    print('没有取到帧'); sys.exit()

arr = np.array(rows, dtype=float)
fr, y0, y1, cx, cy, x0, x1 = (arr[:, i] for i in range(7))
h = y1 - y0
print(f'{src}  帧 {int(fr[0])}~{int(fr[-1])}  共 {len(fr)} 帧')
print(f'  顶边 y0 : {y0.min():.0f} ~ {y0.max():.0f}  起伏 {y0.max() - y0.min():.0f}px')
print(f'  底边 y1 : {y1.min():.0f} ~ {y1.max():.0f}  起伏 {y1.max() - y1.min():.0f}px')
print(f'  水平质心: {cx.min():.0f} ~ {cx.max():.0f}  漂移 {cx.max() - cx.min():.0f}px')

# 用「5 帧滑动平滑后的顶边」找峰谷，估计一个动作周期
k = 3
sm = np.convolve(y0, np.ones(k) / k, mode='same')
piv = []
for i in range(2, len(sm) - 2):
    w = sm[i - 2:i + 3]
    if sm[i] == w.min() or sm[i] == w.max():
        piv.append(int(fr[i]))
print(f'  顶边极值帧: {piv}')

# 画曲线图
if png:
    W, H = 1000, 260
    im = Image.new('RGB', (W, H), (28, 28, 32))
    dr = ImageDraw.Draw(im)
    def pl(vals, color, lbl):
        vmin, vmax = vals.min(), vals.max()
        rng = max(1.0, vmax - vmin)
        pts = [(int(40 + (f - fr[0]) / max(1e-6, fr[-1] - fr[0]) * (W - 60)),
                int(20 + (vmax - v) / rng * (H - 60))) for f, v in zip(fr, vals)]
        dr.line(pts, fill=color, width=2)
        dr.text((6, 20 if lbl == 'top' else 40), lbl, fill=color)
    pl(y0, (255, 140, 90), 'top')
    pl(y1, (110, 200, 255), 'bot')
    pl(cx, (150, 255, 150), 'cx')
    im.save(os.path.join(ROOT, png))
    print(f'  曲线图: {png}')
