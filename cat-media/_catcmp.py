# -*- coding: utf-8 -*-
"""
按应用里的真实渲染尺寸对比各动作，检查「切换动作时猫会不会突然变大变小」。

应用里：容器宽 = 72 * scale，图片 width:100%，容器底边贴地。
所以渲染宽 = 72*scale，渲染高 = 渲染宽 * 素材高/素材宽。
本图把所有动作的脚底对齐到同一条地面线，并画出「待机 72x72」的参考框。

用法: python _catcmp.py [输出png]
"""
import os, sys, io
import numpy as np
from PIL import Image, ImageDraw

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.abspath(__file__))
CAT = os.path.join(os.path.dirname(ROOT), 'app', 'assets', 'cat')
OUT = os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else '_catcmp.png')

DISP_W = 72          # 应用里的基准显示宽度
Z = 4                # 放大倍数（否则 72px 看不出细节）

ITEMS = [
    ('idle 待机',     'cat-idle.webp',    1.0),
    ('walk 走路',     'cat-walk.webp',    1.0),
    ('hop 开心跳',    'cat-hop.webp',     1.15),
    ('stretch 伸懒腰', 'cat-stretch.webp', 1.35),
    ('groom 洗脸',    'cat-groom.webp',   1.14),
    ('doze 打瞌睡',   'cat-doze.webp',    1.0),
    ('sleep 睡觉',    'cat-sleep.webp',   1.0),
]

tiles = []
for label, f, sc in ITEMS:
    p = os.path.join(CAT, f)
    if not os.path.exists(p):
        print(f'跳过（缺素材）: {f}'); continue
    im = Image.open(p)
    n = getattr(im, 'n_frames', 1)
    # 取「猫占屏幕面积最大」的那一帧，最能代表这个动作的视觉体量
    best, bestA = 0, -1
    for i in range(n):
        im.seek(i)
        a = int((np.asarray(im.convert('RGBA'))[:, :, 3] > 40).sum())
        if a > bestA:
            best, bestA = i, a
    im.seek(best)
    frame = im.convert('RGBA')
    w, h = frame.size
    disp_w = DISP_W * sc
    disp_h = disp_w * h / w
    big = frame.resize((int(disp_w * Z), max(1, int(round(disp_h * Z)))), Image.LANCZOS)
    tiles.append((label, big, w, h, disp_w, disp_h, n, best))
    print(f'{label:15s} 素材 {w:4d}x{h:4d}  {n:3d}帧  第{best}帧  渲染 {disp_w:.0f}x{disp_h:.0f}px')

PAD, GAP, LAB = 26, 30, 34
cell_w = int(max(t[1].width for t in tiles)) + GAP
max_h = max(t[1].height for t in tiles)
W = PAD * 2 + cell_w * len(tiles)
H = PAD + max_h + LAB + 40
canvas = Image.new('RGB', (W, H), (252, 250, 247))
dr = ImageDraw.Draw(canvas)
ground = PAD + max_h
dr.line([(PAD - 14, ground), (W - PAD + 14, ground)], fill=(198, 188, 176), width=2)
# 待机参考框：换成 idle 的渲染高度，看看别的动作有没有超出/矮一截
ref_h = next((t[5] for t in tiles if 'idle' in t[0]), 72) * Z
for i, (label, big, w, h, dw, dh, n, bi) in enumerate(tiles):
    x = PAD + i * cell_w
    cx = x + big.width // 2
    dr.rectangle([cx - int(DISP_W * Z / 2), ground - ref_h, cx + int(DISP_W * Z / 2), ground],
                 outline=(230, 170, 150), width=1)
    canvas.paste(big, (x, ground - big.height), big)
    dr.text((x, ground + 8), f'{label}  {n}帧', fill=(40, 40, 40))
    dr.text((x, ground + 8 + 15), f'{w}x{h} 渲染{dw:.0f}x{dh:.0f}', fill=(130, 120, 110))
canvas.save(OUT)
print('\n已生成', OUT, canvas.size, '  （橙框 = 待机的渲染高度参考）')
