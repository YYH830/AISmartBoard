# -*- coding: utf-8 -*-
"""
动作尺度体检：算出各动作在应用里「屏幕上有多大」，检查是否一致。

为什么需要这个工具
──────────────────
应用里猫的容器宽度取自用户设置（cfg.w），图片 width:100%，所以屏幕缩放 = 容器宽 / 素材宽。
而打包流程对【每条视频】都把「猫体包围盒缩到指定高度」再贴紧裁切 —— 这一步抹掉了
「猫在源视频里画了多大」的信息：包围盒越大的姿势被缩得越狠。

结果是：姿势接近方形的动作（站立 / 走路）显示正常，而姿势横向摊开的动作
（伸懒腰、趴卧）在同样宽的容器里，猫的实际尺寸会小掉一大截。
实测伸懒腰只有待机的 56%、睡觉 61% —— 切换动作时能明显看出「猫变小了」。

本工具用「猫在屏幕上的像素面积」当统一口径（面积 ∝ 尺寸²，最能反映"屏幕上有多少猫"），
给出每个动作相对基准动作的偏差，以及所需的放大倍数，填到 app/index.html 的
CAT_ACTIONS[key].scale 即可。

用法
────
    python check_action_scale.py ../app/assets/cat            # 以 idle 为基准
    python check_action_scale.py ../app/assets/cat walk       # 换基准动作
"""
import os, sys, glob
import numpy as np
from PIL import Image

ASSET_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'app', 'assets', 'cat')
BASE = sys.argv[2] if len(sys.argv) > 2 else 'idle'
DISP_W = 72          # 参考显示宽度，只用于换算，不影响比值

rows = []
for f in sorted(glob.glob(os.path.join(ASSET_DIR, 'cat-*.webp'))):
    key = os.path.splitext(os.path.basename(f))[0].replace('cat-', '')
    im = Image.open(f)
    n = getattr(im, 'n_frames', 1)
    W, H = im.size
    areas = []
    for i in range(n):
        im.seek(i)
        areas.append(int((np.asarray(im.convert('RGBA'))[:, :, 3] > 40).sum()))
    k = (DISP_W / W) ** 2                      # 素材像素 → 屏幕像素² 的换算系数
    rows.append(dict(key=key, W=W, H=H, n=n, mean=float(np.mean(areas)), mx=float(max(areas)),
                     mean_scr=float(np.mean(areas)) * k, max_scr=float(max(areas)) * k))

if not rows:
    print(f'{ASSET_DIR} 下没有 cat-*.webp'); sys.exit(1)

print(f'素材目录: {ASSET_DIR}    基准动作: {BASE}')
print(f'{"动作":11s} {"素材":>11s} {"帧数":>4s} {"屏幕面积均值":>11s} {"屏幕面积峰值":>11s}')
print('-' * 58)
for r in rows:
    print(f'{r["key"]:11s} {r["W"]:4d}x{r["H"]:<6d} {r["n"]:4d} {r["mean_scr"]:11.0f} {r["max_scr"]:11.0f}')

base = next((r for r in rows if r['key'] == BASE), None)
if not base:
    print(f'\n找不到基准动作 {BASE}，只列出数据。'); sys.exit(0)

print(f'\n相对 {BASE} 的屏幕面积占比，以及要「看起来一样大」所需的 scale：')
print('（面积 ∝ 尺寸²，所以 scale = sqrt(基准峰值面积 / 本动作峰值面积)）')
print(f'{"动作":11s} {"面积占比":>8s} {"建议 scale":>10s} {"建议显示宽":>10s}  说明')
for r in rows:
    pct = r['max_scr'] / base['max_scr'] * 100
    f = (base['max_scr'] / r['max_scr']) ** 0.5
    note = '基准' if r['key'] == BASE else ('差距可忽略，不必补偿' if abs(f - 1) < 0.08 else '需要补偿')
    print(f'{r["key"]:11s} {pct:7.0f}% {f:10.2f} {DISP_W*f:9.0f}px  {note}')
print('\n把「建议 scale」填进 app/index.html 的 CAT_ACTIONS[key].scale 即可。')
