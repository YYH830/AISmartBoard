# -*- coding: utf-8 -*-
"""
在已抠好的帧目录里扫描「自相似周期」：
对每个滞后 L，计算所有起点 i 的 diff(i, i+L) 均值曲线，
曲线上的极小值处就是最像的周期（帧数为整数时才有完美闭合）。
用法: python _period.py cat-doze-frames [最大滞后]
"""
import os, sys, io, glob, re
import numpy as np
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.abspath(__file__))


def diff(a, b):
    m = (a[:, :, 3] > 30) | (b[:, :, 3] > 30)
    if m.sum() < 50:
        return 1e9
    return float(np.abs(a[:, :, :3].astype(np.float32) - b[:, :, :3].astype(np.float32)).mean(axis=2)[m].mean())


name = sys.argv[1] if len(sys.argv) > 1 else 'cat-doze'
maxlag = int(sys.argv[2]) if len(sys.argv) > 2 else 40
# 可选：只取前 N 帧分析（素材若是乒乓循环，后半段是倒放，会污染周期判断）
only = int(sys.argv[3]) if len(sys.argv) > 3 else 0

d = os.path.join(ROOT, 'processed', f'{name}-frames')
files = sorted(glob.glob(os.path.join(d, '*.png')), key=lambda p: int(re.search(r'(\d+)', os.path.basename(p)).group(1)))
ims = [np.asarray(Image.open(f).convert('RGBA')) for f in files]
if only:
    ims = ims[:only]
n = len(ims)
print(f'--- {name}  取前 {n} 帧分析 ---')

adj = [diff(ims[i], ims[i + 1]) for i in range(n - 1)]
print(f'  相邻帧差均值 step = {np.mean(adj):.2f}')

# 逐帧对比所有滞后，得到 L -> 平均差
rows = []
for L in range(2, min(maxlag, n - 1) + 1):
    ds = [diff(ims[i], ims[i + L]) for i in range(n - L)]
    rows.append((L, float(np.mean(ds)), len(ds)))

print('\n  滞后L  平均差   起点数   与step比')
best = sorted(rows, key=lambda r: r[1])[:8]
bestL = set(r[0] for r in best)
for L, m, c in rows:
    mark = '  <== 候选' if L in bestL else ''
    print(f'  {L:5d}  {m:7.2f}  {c:6d}   {m / max(1e-6, np.mean(adj)):5.2f}{mark}')
