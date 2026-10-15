# -*- coding: utf-8 -*-
"""
从已抠好的帧目录重新打包循环动画（免去重新抠图，秒级迭代）。

为什么需要它
────────────
process_walk.py 的抠图是全流程最慢的一步（97 帧 × 960×960，单条视频约 6 分钟），
但「挑哪一段做循环、抽几帧、压多少质量」这些参数往往要试好几轮。
把帧目录（processed/<名>-frames/，已经是「对齐 + 贴紧裁切」后的成品帧）当输入，
只重做「选段 → 乒乓 → 抽帧 → 编码」，一轮只要几秒，
既不用重抠图，也不会因为重跑而改变已经定稿的画面。

用法
────
    # 先看看逐帧变化，挑"动作最连贯"的一段
    python repack_loop.py processed/cat-sleep-frames --profile

    # 取第 30~60 帧、乒乓循环、每隔 2 帧取一帧，导出 processed/cat-sleep.webp
    python repack_loop.py processed/cat-sleep-frames --out cat-sleep \
        --range 30 60 --pingpong --stride 2 --lossy 88

参数
────
    --out 名     输出名（写到 processed/<名>.webp|.gif|.json），默认沿用帧目录名
    --range A B  只取帧区间 [A, B]（默认整段）
    --pingpong   乒乓循环（正放+倒放），闭合处天然无缝
    --stride N   每隔 N 帧取一帧，每帧时长相应延长到 1000/24*N 毫秒
    --lossy Q    有损 webp 质量（默认 88）；不传则无损
    --profile    只打印逐帧变化曲线，帮助挑区间，不导出
"""
import os, sys, json, glob
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(ROOT, 'processed')

argv = sys.argv[1:]
frames_dir = None
out_name, rng, pingpong, stride, lossy, profile = None, None, False, 1, 88, False
i = 0
while i < len(argv):
    a = argv[i]
    if a == '--out':
        out_name, i = argv[i + 1], i + 2
    elif a == '--range':
        rng, i = (int(argv[i + 1]), int(argv[i + 2])), i + 3
    elif a == '--pingpong':
        pingpong, i = True, i + 1
    elif a == '--stride':
        stride, i = max(1, int(argv[i + 1])), i + 2
    elif a == '--lossy':
        lossy, i = int(argv[i + 1]), i + 2
    elif a == '--profile':
        profile, i = True, i + 1
    elif a == '--lossless':
        lossy, i = None, i + 1
    else:
        frames_dir, i = a, i + 1

if not frames_dir:
    print(__doc__)
    sys.exit(1)
if not os.path.isabs(frames_dir):
    frames_dir = os.path.join(ROOT, frames_dir)


def frame_sort_key(path):
    """帧文件按文件名里的【数字】排序。

    为什么不能直接 sorted()：帧名是 00.png / 100.png 这种定宽补零，
    一旦总帧数超过 100 就混进了三位数，字符串排序会把 '100.png' 排在
    '11.png' 前面 —— 于是帧序变成「…09, 10, 100~109, 11, 110~119…」，
    每 11 个一组跳着放。动画看上去就是不停地乱闪，而数值指标却可能"看着还行"。
    这是个很难从画面上反推到原因的错误，所以这里显式按数字排。"""
    stem = os.path.splitext(os.path.basename(path))[0]
    try:
        return (0, int(stem), '')
    except ValueError:
        return (1, 0, stem)


files = sorted(glob.glob(os.path.join(frames_dir, '*.png')), key=frame_sort_key)
if not files:
    print(f'{frames_dir} 里没有帧图'); sys.exit(1)

imgs = [Image.open(f).convert('RGBA') for f in files]
N = len(imgs)
NAME = out_name or os.path.basename(frames_dir.rstrip('/\\')).replace('-frames', '')
print(f'[{NAME}] 读入 {N} 帧，{imgs[0].size[0]}x{imgs[0].size[1]}')


def fdiff(a, b):
    """两帧的平均像素差（只看任一帧不透明的区域），转 float32 防止 uint8 溢出回绕"""
    m = (a[:, :, 3] > 30) | (b[:, :, 3] > 30)
    if m.sum() < 50:
        return 1e9
    return float(np.abs(a[:, :, :3].astype(np.float32) - b[:, :, :3].astype(np.float32)).mean(axis=2)[m].mean())


# ---------------- 逐帧变化曲线（挑区间用） ----------------
small = [np.asarray(im.resize((max(1, im.width // 2), max(1, im.height // 2)), Image.LANCZOS),
                    dtype=np.float32) for im in imgs]
steps = [fdiff(small[k], small[k + 1]) for k in range(N - 1)]

if profile:
    print(f'\n逐帧变化曲线（每 8 帧一档，共 {N} 帧；数值越大说明这一段动得越明显）：')
    for s in range(0, N - 1, 8):
        seg = steps[s:s + 8]
        avg = sum(seg) / len(seg)
        bar = '#' * max(1, int(avg / max(1e-6, max(steps)) * 48))
        print(f'  帧 {s:3d}~{min(s+7, N-1):3d}  {avg:6.2f}  {bar}')
    print(f'\n  最大变化 {max(steps):.2f} 在帧 {int(np.argmax(steps))} 附近；'
          f'整体均值 {np.mean(steps):.2f}')
    print('  挑区间建议：取一段「变化均匀、首尾姿势接近」的窗口，'
          '再用 --pingpong 就不必强求首尾完全一致。')
    # 同时给出「首尾最接近」的窗口建议
    cand = []
    for p in range(12, min(N // 2, 80)):
        gap = np.mean([fdiff(small[k], small[k + p]) for k in range(0, N - p, max(1, (N - p) // 10))])
        cand.append((gap, p))
    cand.sort()
    print('  自相似周期候选（首尾差越小越"能自己接上"）：' +
          '、'.join(f'{p}帧/{p/24:.1f}s(差{g:.1f})' for g, p in cand[:4]))
    sys.exit(0)

# ---------------- 选段 ----------------
A, B = rng if rng else (0, N - 1)
A, B = max(0, A), min(N - 1, B)
seg = imgs[A:B + 1]
print(f'  取段: 帧 {A} ~ {B}（{len(seg)} 帧，{len(seg)/24.0:.2f} 秒）')

# ---------------- 乒乓 ----------------
if pingpong:
    seq = list(seg) + list(seg[-2:0:-1]) if len(seg) > 2 else list(seg)
    how = '乒乓循环'
else:
    seq = list(seg)
    how = '直放（首尾需自相似）'
print(f'  {how}: {len(seq)} 帧')

# ---------------- 抽帧 ----------------
if stride > 1:
    seq = seq[::stride]
    print(f'  每隔 {stride} 帧取一帧 → {len(seq)} 帧')

duration = int(round(1000 / 24 * stride))
final = seq

# 闭合质量：首尾差 vs 逐帧相邻差
sa = [np.asarray(im, dtype=np.float32) for im in final]
sd = [fdiff(sa[k], sa[k + 1]) for k in range(len(sa) - 1)]
stepd = float(np.mean(sd)) if sd else 0.0
gapd = fdiff(sa[-1], sa[0])

# ---------------- 导出 ----------------
os.makedirs(OUTDIR, exist_ok=True)
webp_kw = dict(lossless=False, quality=lossy, method=6) if lossy else dict(lossless=True)
webp = os.path.join(OUTDIR, f'{NAME}.webp')
gif = os.path.join(OUTDIR, f'{NAME}.gif')
final[0].save(webp, save_all=True, append_images=final[1:], duration=duration, loop=0, **webp_kw)
final[0].save(gif, save_all=True, append_images=final[1:], duration=duration, loop=0, transparency=0)

meta = dict(source=os.path.basename(frames_dir), loop_mode=how, frames=len(final),
            stride=stride, frame_size=[final[0].width, final[0].height], duration_ms=duration,
            loop_step_diff=round(stepd, 2), loop_gap_diff=round(gapd, 2))
with open(os.path.join(OUTDIR, f'{NAME}.json'), 'w', encoding='utf-8') as fp:
    json.dump(meta, fp, ensure_ascii=False, indent=2)

print(f'  循环质量: 逐帧相邻差 {stepd:.2f}，首尾闭合差 {gapd:.2f} '
      f'(比值 {gapd / max(1e-6, stepd):.2f}，≤1.6 视为无缝)')
print(f'  输出: {webp}  {os.path.getsize(webp)/1024:.0f} KB  '
      f'{len(final)} 帧 × {duration}ms = {len(final)*duration/1000:.1f}s  {final[0].size}')
