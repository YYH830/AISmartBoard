# -*- coding: utf-8 -*-
"""
校验「各动作绿幕首帧」是否满足交给视频模型的条件：
  1) 背景是否为均匀纯绿 #00B140
  2) 猫有没有被画面边缘裁切（四周留白）
  3) 各动作之间猫的大小/位置是否一致（不一致会导致切换动作时大小突变）
另出一张总览拼图，便于人眼比对是否同一只猫。
"""
import os, sys, io
import numpy as np
from PIL import Image, ImageDraw

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(ROOT, 'refs', 'actions')
REF = os.path.join(ROOT, 'refs', 'green', 'E2-peach-green-00B140.png')

ORDER = [('idle', '待机站立'), ('doze', '打瞌睡'), ('sleep', '睡觉'),
         ('stretch', '伸懒腰'), ('groom', '舔毛洗脸'), ('hop', '开心跳')]

TARGET_BG = np.array([0, 177, 64], dtype=np.float32)   # 规范绿 #00B140（仅作参考展示）
GREEN_MIN = 45        # 绿优势低于此值判为主体（非绿）
BG_GREEN_MIN = 70     # 背景绿优势合格线


def analyze(p):
    im = Image.open(p).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    h, w = a.shape[:2]
    # 主体判定用「绿优势」而不是「与 #00B140 的差值」：
    # 模型给的绿幕常有亮度渐变（比如边缘偏亮 [80,197,103]），
    # 用差值判定会把这类背景误判成猫，从而报出假的「贴边/裁切」。
    gn = a[:, :, 1] - np.maximum(a[:, :, 0], a[:, :, 2])
    fg = gn < GREEN_MIN
    ys, xs = np.where(fg)
    if len(ys) == 0:
        return None
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    # 背景质量：取四角区域，看绿优势中位数（越高越纯）与波动（越小越均匀）
    m = int(min(h, w) * 0.04)
    corners_gn = np.concatenate([gn[:m, :m].ravel(), gn[:m, -m:].ravel(),
                                 gn[-m:, :m].ravel(), gn[-m:, -m:].ravel()])
    return dict(size=(w, h), bbox=(x0, y0, x1, y1),
                cw=x1 - x0 + 1, ch=y1 - y0 + 1, cx=(x0 + x1) / 2, cy=(y0 + y1) / 2,
                margins=(x0, w - 1 - x1, y0, h - 1 - y1),
                bg_green=float(np.median(corners_gn)), bg_std=float(corners_gn.std()),
                px=int(fg.sum()))


print(f'主体判定：绿优势 < {GREEN_MIN}；背景合格线：绿优势 ≥ {BG_GREEN_MIN}')
print('=' * 104)
print(f'{"动作":<10}{"猫宽x高":>12}{"占画幅宽":>9}{"四周留白 L/R/T/B":>24}'
      f'{"背景绿优势":>11}{"背景波动":>9}{"是否裁切":>9}')
print('-' * 104)
rows = {}
for key, cn in ORDER:
    p = os.path.join(DIR, f'{key}-first.png')
    if not os.path.exists(p):
        print(f'{cn:<10} 缺失'); continue
    r = analyze(p)
    rows[key] = r
    ml, mr, mt, mb = r['margins']
    clip = '否' if min(r['margins']) > 1 else '是(贴边)'
    bgok = '' if r['bg_green'] >= BG_GREEN_MIN else ' 低'
    print(f'{cn:<10}{str((r["cw"], r["ch"])):>12}{r["cw"] / r["size"][0] * 100:>8.0f}%'
          f'{str((ml, mr, mt, mb)):>24}{r["bg_green"]:>10.0f}{bgok}{r["bg_std"]:>9.1f}{clip:>9}')

# ---- 一致性：只比较「位置」，不比包围盒大小 ----
# 包围盒宽高随姿势天然变化（坐姿比站姿窄、蜷缩比站立矮），拿它比大小会得出错误结论，
# 所以这里只报中心位置偏差；跨动作的真实大小一致性靠下方的总览拼图人眼判断。
if 'idle' in rows:
    base = rows['idle']
    print('\n与「待机站立」的中心位置偏差（仅位置；大小受姿势影响，请见拼图）：')
    for key, cn in ORDER:
        if key not in rows or key == 'idle':
            continue
        r = rows[key]
        dx = (r['cx'] - base['cx']) / base['size'][0] * 100
        dy = (r['cy'] - base['cy']) / base['size'][1] * 100
        flag = '' if max(abs(dx), abs(dy)) <= 15 else '  <-- 位置偏得多'
        print(f'  {cn:<8} 中心X {dx:+5.1f}%   中心Y {dy:+5.1f}%{flag}')

# ---- 总览拼图 ----
CELL = 340
sh = Image.new('RGB', (3 * CELL + 4 * 10, 2 * (CELL + 26) + 10), (236, 234, 231))
dr = ImageDraw.Draw(sh)
for i, (key, cn) in enumerate(ORDER):
    p = os.path.join(DIR, f'{key}-first.png')
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB').resize((CELL, CELL), Image.LANCZOS)
    d2 = ImageDraw.Draw(im)
    # 10% 安全边距参考框
    inset = int(CELL * 0.10)
    d2.rectangle([inset, inset, CELL - inset, CELL - inset], outline=(255, 90, 90), width=2)
    cx = 10 + (i % 3) * (CELL + 10)
    cy = 10 + (i // 3) * (CELL + 26)
    sh.paste(im, (cx, cy))
    dr.text((cx + 3, cy + CELL + 5), f'{key}  {cn}', fill=(50, 42, 36))
out = os.path.join(ROOT, 'actions-sheet.png')
sh.save(out)
print(f'\n总览拼图（红框 = 10% 安全边距，猫不得越框）: {out}')
