"""
猫猫素材体检：加新动作 / 重新生成素材后，用它客观复检，不用靠肉眼反复看。

检查三件事
─────────
1. 毛发长度   轮廓的高频细节量。长毛是「一圈细密毛刺」，短毛是「平滑的线」。
              这是本次踩过的坑：提示词里误写成「短毛」，模型忠实照做，猫全变短毛了。
2. 毛色一致性 以「应用现用的素材」为基准比较色调 / 饱和度 / 明度。
              各动作是独立生成的，若偏差过大，切换动作时会像换了一只猫。
3. 尺寸与占比 猫在画幅里的外接框与像素占比，用于发现「画得过大/过小」。

为什么毛长要用「轮廓细节」而不是面积或周长
────────────────────────────────────────
面积 / 周长会被姿势严重干扰（坐、躺、蜷成一团本来形状就差很多）。
而「轮廓的毛刺多少」是低频形状之外的细节量：把掩膜降采样再升回来，
细毛刺会被抹掉、整体形状保留，两者的边界像素数之比就只反映细节多少。

为什么用 app 里的素材当毛色基准，而不是 refs/green 的参考图
────────────────────────────────────────────────────────
应用里真正显示的是 app/assets/cat/*.webp（由视频生成），
参考图是抠图前的绿幕图，亮度与它并不一致 —— 实测参考图比 app 素材更亮，
拿参考图当基准会得出「新素材偏暗」的错误结论。

用法
────
    python cat_check.py                     # 检查默认的一组（参考图 + 各动作首帧）
    python cat_check.py 图1.png 图2.png      # 检查指定图片
    python cat_check.py --frames            # 只检查 refs/actions/ 下的 *-first.png
"""

import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

REF_GREEN = os.path.join(HERE, "refs", "green", "E2-peach-green-00B140.png")
ACTIONS_DIR = os.path.join(HERE, "refs", "actions")
APP_ASSETS = [
    os.path.join(ROOT, "app", "assets", "cat", "cat-walk.webp"),
    os.path.join(ROOT, "app", "assets", "cat", "cat-idle.webp"),
]
ACTION_KEYS = ["doze", "sleep", "stretch", "groom", "hop"]

# ── 毛发判读的适用范围与校准 ──────────────────────────────────────────
# ⚠ 这个指标只在「同样的像素尺寸」之间可比：
#     大图（1024px）缩小会把毛发细节抹平，小图（100px）放大又是插值假象，
#     两者放在一起比会得出错误结论（实测归一化到同一体高后，长毛与短毛完全重叠）。
#   本项目校准值（均为 1024x1024）：
#     参考图（已知长毛）fringe = 0.0016
#     旧版首帧（已知短毛）fringe = 0.0006 ~ 0.0010
#     重生成后          fringe = 0.0011 ~ 0.0014
#   故取「参考图的 75%」为下限提示线；这只是**粗略提示**，最终仍须肉眼确认。
#
# ⚠ rough（边界粗糙度）经实测**无法区分**长毛与短毛（两组数值完全重叠），
#   因此只作为参考数字打印，不参与任何判定。
FUR_REF_RATIO_WARN = 0.90   # 低于参考图此比例 → 提示「偏短，建议眼看」
FUR_REF_RATIO_BAD = 0.75    # 低于此比例 → 提示「明显偏短」

# 毛色容许偏差（相对 app 现用素材的均值）
HUE_TOL = 6.0             # 色调差容许范围（度）
SAT_TOL = 45.0            # 饱和度差容许范围
VAL_TOL = 30.0            # 明度差容许范围


# ────────────────────────────── 读图与掩膜 ──────────────────────────────

def imread_unicode(path, flags=cv2.IMREAD_UNCHANGED):
    """读图，兼容中文路径（cv2.imread 在 Windows 下不支持非 ASCII 路径）"""
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        return cv2.imdecode(buf, flags) if buf.size else None
    except Exception:
        return None


def body_mask(img):
    """取猫体掩膜：有 alpha 通道就用 alpha，否则按绿幕判定；只保留最大连通域"""
    if img is None:
        return None
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


def boundary_pixels(m):
    """边界像素数（有背景邻居的前景像素），近似周长"""
    er = cv2.erode(m, np.ones((3, 3), np.uint8), iterations=1)
    return int((m - er).sum())


# ────────────────────────────── 各项测量 ──────────────────────────────

def measure(path, factor=4):
    """测一只猫：毛发指标 + 色彩 + 尺寸"""
    img = imread_unicode(path)
    if img is None:
        return {"文件": os.path.basename(path), "错误": "读图失败"}
    m = body_mask(img)
    if m is None or m.sum() == 0:
        return {"文件": os.path.basename(path), "错误": "未识别到主体"}

    h, w = m.shape
    area = int(m.sum())

    # --- 毛发指标一：边界粗糙度（对姿势不敏感）---
    small = cv2.resize(m * 255, (max(1, w // factor), max(1, h // factor)),
                       interpolation=cv2.INTER_AREA)
    back = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    m_low = (back > 127).astype(np.uint8)
    rough = boundary_pixels(m) / max(1, boundary_pixels(m_low))

    # --- 毛发指标二：外缘碎屑率（平滑一遍后抹掉多少面积）---
    k = np.ones((7, 7), np.uint8)
    smooth = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
    smooth = cv2.morphologyEx(smooth, cv2.MORPH_OPEN, k)
    fringe = float((m & (~smooth.astype(bool)).astype(np.uint8)).sum()) / max(1, area)

    # --- 色彩：只取猫体内部，避开与背景混合的边缘像素 ---
    core = cv2.erode(m, np.ones((5, 5), np.uint8), iterations=2)
    rgb = img[:, :, :3]
    if core.sum() > 0:
        px = rgb[core > 0]
        med = np.median(px, axis=0)                       # BGR
        hsv = cv2.cvtColor(px.reshape(-1, 1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3)
        hue, sat, val = (float(np.median(hsv[:, 0])), float(np.median(hsv[:, 1])),
                         float(np.median(hsv[:, 2])))
    else:
        med = np.array([np.nan] * 3)
        hue = sat = val = float("nan")

    # --- 尺寸 ---
    ys, xs = np.where(m > 0)
    bw, bh = int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)

    return {
        "文件": os.path.basename(path),
        "画幅": f"{w}x{h}",
        "体宽": bw, "体高": bh,
        "宽占比": bw / w * 100,
        "面积占比": area / (w * h) * 100,
        "rough": rough,
        "fringe": fringe,
        "hue": hue, "sat": sat, "val": val,
        "rgb": f"({med[2]:.0f},{med[1]:.0f},{med[0]:.0f})",
    }


# ────────────────────────────── 输出 ──────────────────────────────

def fmt_table(rows, cols, titles=None, fmts=None):
    """按列宽对齐打印表格。fmts 可为每列指定格式（如 fringe 需要 4 位小数）"""
    titles = titles or {}
    fmts = fmts or {}
    heads = [titles.get(c, c) for c in cols]

    def cell(r, c):
        v = r.get(c, "")
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return "-"
        if isinstance(v, float):
            return format(v, fmts.get(c, ".3f"))
        return str(v)

    widths = {c: len(titles.get(c, c)) for c in cols}
    for r in rows:
        for c in cols:
            widths[c] = max(widths[c], len(cell(r, c)))

    print("  ".join(titles.get(c, c).ljust(widths[c]) for c in cols))
    print("  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  ".join(cell(r, c).ljust(widths[c]) for c in cols))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only_frames = "--frames" in sys.argv

    if args:
        paths = [a if os.path.isabs(a) else os.path.join(os.getcwd(), a) for a in args]
    elif only_frames:
        paths = [os.path.join(ACTIONS_DIR, f"{k}-first.png") for k in ACTION_KEYS]
    else:
        paths = [REF_GREEN] + [os.path.join(ACTIONS_DIR, f"{k}-first.png") for k in ACTION_KEYS]

    rows = [measure(p) for p in paths if os.path.exists(p)]
    if not rows:
        print("没有可检查的图片")
        return

    print()
    print("【一】毛发与尺寸")
    print("（rough 经实测无法区分长毛/短毛，仅列作参考；判断请以 fringe 与人眼为准）")
    fmt_table(rows, ["文件", "画幅", "体宽", "体高", "宽占比", "面积占比", "rough", "fringe"],
              {"宽占比": "宽占比%", "面积占比": "面积占比%"},
              {"宽占比": ".1f", "面积占比": ".1f", "rough": ".3f", "fringe": ".4f"})

    # 毛发判读：只以「同为 1024px 的参考图」为基准做相对比较
    print()
    ref_row = next((r for r in rows if r.get("文件") == os.path.basename(REF_GREEN)), None)
    measurable = [r for r in rows if "fringe" in r]
    note_bad, note_warn = [], []
    if ref_row and measurable:
        ref_fr = ref_row["fringe"]
        print(f"毛发提示（基准：参考图 fringe={ref_fr:.4f}，仅对同尺寸图片有效）：")
        for r in measurable:
            if r is ref_row:
                continue
            ratio = r["fringe"] / ref_fr if ref_fr else 0
            if ratio < FUR_REF_RATIO_BAD:
                note_bad.append((r["文件"], ratio))
            elif ratio < FUR_REF_RATIO_WARN:
                note_warn.append((r["文件"], ratio))
            print(f"    {r['文件']:26} fringe={r['fringe']:.4f}  为参考图的 {ratio * 100:.0f}%")
        print()
        if note_bad:
            print("⚠ 明显偏短（毛发偏光滑），建议重新生成：")
            for f, rt in note_bad:
                print(f"    {f}  ({rt * 100:.0f}%)")
            print("  → 检查提示词里是否误写了「短毛」，或缺少「长毛蓬松」的描述。")
        if note_warn:
            print("· 略低于参考图，建议眼看确认（指标本身不够灵敏）：")
            for f, rt in note_warn:
                print(f"    {f}  ({rt * 100:.0f}%)")
        if not note_bad and not note_warn:
            print("✓ 毛发指标未见明显异常。")
        print()
        print("⚠ 注意：该指标只是粗略提示，实测无法可靠区分长毛与短毛。")
        print("   判断毛发是否达标，请以 python cat_compare.py 出的对照图为准（人眼更准）。")
    elif measurable:
        print("未找到参考图，跳过毛发比较（需要参考图作为同尺寸基准）。")

    # 色彩一致性：以 app 现用素材为基准
    print()
    print("【二】毛色一致性（基准 = app 现用素材）")
    app_rows = []
    for p in APP_ASSETS:
        if os.path.exists(p):
            app_rows.append(measure(p))
    if not app_rows:
        print("  未找到 app/assets/cat 下的素材，跳过色彩比较")
    else:
        for r in app_rows:
            print(f"  基准 {r['文件']:16} 中位RGB {r['rgb']}  色调 {r['hue']:.0f} "
                  f"饱和 {r['sat']:.0f} 明度 {r['val']:.0f}")
        # 基准自身的波动范围 = 可接受范围
        b_hue = [r["hue"] for r in app_rows]
        b_sat = [r["sat"] for r in app_rows]
        b_val = [r["val"] for r in app_rows]
        print(f"  基准自身波动：色调 {max(b_hue) - min(b_hue):.0f}度  "
              f"饱和 {max(b_sat) - min(b_sat):.0f}  明度 {max(b_val) - min(b_val):.0f}")
        print("  （基准素材彼此就有差异，新素材落在同一量级即视为一致）")
        print()
        base_h = float(np.mean(b_hue)); base_s = float(np.mean(b_sat)); base_v = float(np.mean(b_val))
        flags = []
        for r in rows:
            if "hue" not in r or np.isnan(r["hue"]):
                continue
            d_h, d_s, d_v = r["hue"] - base_h, r["sat"] - base_s, r["val"] - base_v
            mark = ""
            if abs(d_h) > HUE_TOL or abs(d_s) > SAT_TOL or abs(d_v) > VAL_TOL:
                mark = "  ⚠ 偏差偏大"
                flags.append(r["文件"])
            print(f"  {r['文件']:26} Δ色调 {d_h:+6.1f}  Δ饱和 {d_s:+6.1f}  Δ明度 {d_v:+6.1f}{mark}")
        print()
        if flags:
            print("⚠ 以下素材与基准偏差较大，切换动作时可能看出「换了一只猫」：")
            for f in flags:
                print("    " + f)
        else:
            print("✓ 毛色与基准一致（在容许范围内）。")

    print()
    print("提示：光看指标可能漏掉姿势 / 条纹的问题，建议再跑 python cat_compare.py 出对照图亲眼看一下。")
    print()


if __name__ == "__main__":
    main()
