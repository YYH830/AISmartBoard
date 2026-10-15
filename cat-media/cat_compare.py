"""
猫猫素材对照图：把「应用现用素材」「参考图」「各动作首帧」拼成一张等比例对比图。

为什么要把应用现用素材放在最前面
────────────────────────────────
应用里真正显示的就是 app/assets/cat/*.webp，它们才是「同一只猫」的判据。
新生成的各动作必须和它们看起来一致，否则挂件切换动作时会像换了一只猫。

为什么要按体高统一对齐
──────────────────────
原图里各姿势的猫大小不一（有的画得大、有的小），直接并排会把
「画得小」误看成「毛短」。统一缩放到同一体高后，比较的才是毛发本身。

用法
────
    python cat_compare.py                # 出 cat-media/cat-compare.png（默认一组）
    python cat_compare.py --diff         # 旧版短毛 vs 新版 的对照图（排查毛长问题时用）
"""

import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

REF_GREEN = os.path.join(HERE, "refs", "green", "E2-peach-green-00B140.png")
ACTIONS = os.path.join(HERE, "refs", "actions")
BACKUP = os.path.join(ACTIONS, "_backup-shorthair")
ACTION_LABELS = [("doze", "doze 打瞌睡"), ("sleep", "sleep 睡觉"), ("stretch", "stretch 伸懒腰"),
                 ("groom", "groom 洗脸"), ("hop", "hop 开心跳")]

TARGET_H = 200      # 每只猫统一到的高度
PAD = 8             # 裁紧后留白
GAP = 10
HEADER_H = 26


def imread_unicode(path):
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        return cv2.imdecode(buf, cv2.IMREAD_UNCHANGED) if buf.size else None
    except Exception:
        return None


def body_mask(img):
    """猫体掩膜：有 alpha 用 alpha，否则按绿幕判定；只保留最大连通域"""
    if img.ndim == 3 and img.shape[2] == 4:
        m = (img[:, :, 3] > 128).astype(np.uint8)
    else:
        b, g, r = cv2.split(img[:, :, :3].astype(np.int16))
        m = (~((g > r + 20) & (g > b + 20))).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return None
    idx = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    return (lab == idx).astype(np.uint8)


def to_bgr_white(img):
    """带透明通道的合成到白底，便于拼图对比"""
    if img.ndim == 3 and img.shape[2] == 4:
        a = img[:, :, 3:4].astype(np.float32) / 255.0
        return (img[:, :, :3].astype(np.float32) * a + 255.0 * (1 - a)).astype(np.uint8)
    return img[:, :, :3]


def prep(path):
    """读图 → 合成白底 → 按猫体裁紧 → 统一体高"""
    img = imread_unicode(path)
    if img is None:
        return None
    bgr = to_bgr_white(img)
    m = body_mask(img)
    if m is not None:
        ys, xs = np.where(m > 0)
        y0, y1 = max(0, ys.min() - PAD), min(bgr.shape[0], ys.max() + 1 + PAD)
        x0, x1 = max(0, xs.min() - PAD), min(bgr.shape[1], xs.max() + 1 + PAD)
        bgr = bgr[y0:y1, x0:x1]
    s = TARGET_H / bgr.shape[0]
    return cv2.resize(bgr, (max(1, int(round(bgr.shape[1] * s))), TARGET_H),
                      interpolation=cv2.INTER_AREA)


def montage(tiles, dest_name, note):
    """把 [(标签, 图)] 横排拼成一张图并保存"""
    if not tiles:
        print("没有可用的图片")
        return
    cell_w = max(t.shape[1] for _, t in tiles) + GAP
    width = cell_w * len(tiles) + GAP
    height = HEADER_H + TARGET_H + GAP
    canvas = np.full((height, width, 3), 255, np.uint8)

    for c, (_, t) in enumerate(tiles):
        x = GAP + c * cell_w
        canvas[HEADER_H:HEADER_H + t.shape[0], x:x + t.shape[1]] = t

    out = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
    d = ImageDraw.Draw(out)
    for c, (label, _) in enumerate(tiles):
        d.text((GAP + c * cell_w + 4, 8), label, fill=(0, 0, 0))

    dest = os.path.join(HERE, dest_name)
    out.save(dest)
    print("已生成:", dest)
    print("  " + note)


def main():
    if "--diff" in sys.argv:
        # 行 = 动作；列 = 参考图 / 旧版短毛 / 新版
        tiles = []
        ref = prep(REF_GREEN)
        if ref is not None:
            tiles.append(("参考图(基准)", ref))
        for key, cn in ACTION_LABELS:
            old = prep(os.path.join(BACKUP, f"{key}-first.png"))
            if old is not None:
                tiles.append((f"旧 {cn}", old))
            new = prep(os.path.join(ACTIONS, f"{key}-first.png"))
            if new is not None:
                tiles.append((f"新 {cn}", new))
        montage(tiles, "cat-diff.png", "左起：参考图 → 各动作的「旧(短毛) / 新」交替排列。")
        return

    # 常规：app 现用素材 + 参考图 + 各动作首帧
    tiles = []
    for label, p in [("app现用 walk", os.path.join(ROOT, "app", "assets", "cat", "cat-walk.webp")),
                     ("app现用 idle", os.path.join(ROOT, "app", "assets", "cat", "cat-idle.webp")),
                     ("参考图(绿幕)", REF_GREEN)]:
        t = prep(p) if os.path.exists(p) else None
        if t is not None:
            tiles.append((label, t))
    for key, cn in ACTION_LABELS:
        t = prep(os.path.join(ACTIONS, f"{key}-first.png"))
        if t is not None:
            tiles.append((cn, t))
    montage(tiles, "cat-compare.png",
            "前两个是 app 现用素材（一致性基准），其后是参考图与各动作首帧；均已按体高对齐。")


if __name__ == "__main__":
    main()
