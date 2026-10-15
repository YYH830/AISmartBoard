# -*- coding: utf-8 -*-
"""
判断循环质量：
  - 逐帧相邻差 step：相邻两帧的差异，代表动画本身的运动量
  - 首尾闭合差 gap：最后一帧回到第一帧的差异
  循环流畅的条件是 gap ≈ step。若 gap 明显大于 step，
  播放到末尾回接开头时就会「跳一下」。
另外评估「乒乓循环」（正放+倒放）的闭合差：按构造恒为 0。
"""
import os, sys, io, glob
import numpy as np
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.abspath(__file__))


def diff(a, b):
    """掩码内平均 RGB 差（0~255）"""
    m = (a[:, :, 3] > 30) | (b[:, :, 3] > 30)
    if m.sum() < 50:
        return 1e9
    return float(np.abs(a[:, :, :3].astype(np.float32) - b[:, :, :3].astype(np.float32)).mean(axis=2)[m].mean())


for name in sys.argv[1:] or ['cat-idle']:
    d = os.path.join(ROOT, 'processed', f'{name}-frames')
    files = sorted(glob.glob(os.path.join(d, '*.png')))
    if not files:
        print(f'{name}: 没找到帧目录'); continue
    ims = [np.asarray(Image.open(f).convert('RGBA')) for f in files]
    n = len(ims)
    steps = [diff(ims[i], ims[i + 1]) for i in range(n - 1)]
    gap = diff(ims[-1], ims[0])
    print(f'--- {name}  共 {n} 帧 ---')
    print(f'  逐帧相邻差 step: 均值 {np.mean(steps):6.2f}   最大 {np.max(steps):6.2f}')
    print(f'  首尾闭合差 gap : {gap:6.2f}   (gap/step = {gap / max(1e-6, np.mean(steps)):.2f})')
    verdict = '循环流畅' if gap <= np.mean(steps) * 1.6 else '回接时会跳一下，建议改乒乓循环'
    print(f'  结论: {verdict}')
    # 乒乓循环的闭合差：正放最后一帧 → 倒放第一帧（即原倒数第二帧），天然的相邻帧
    pp_gap = diff(ims[-1], ims[-2]) if n >= 2 else None
    if pp_gap is not None:
        print(f'  若改乒乓循环: 闭合处就是原有的相邻帧，gap = {pp_gap:.2f}（天然无缝）')
