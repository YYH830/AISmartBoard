# -*- coding: utf-8 -*-
"""
动画帧序体检：判断动图的帧有没有按正确顺序排，避免「画面一直乱闪」。

为什么需要它
────────────
帧序错乱在其它指标上都很隐蔽：每帧内容都对、帧数也对、时长为正、体积正常，
但播放时画面乱跳。而「相邻帧像不像」单看说不准 —— 慢动作（呼吸、待机）
所有帧本来就都很像，快动作相邻帧本来就不太像，拿固定阈值比必然误判。

本工具用的判据是「差异随间隔的增长速度」：
    把 D(k) 记作「间隔 k 帧的两帧平均差异」，正常动画里 D(k) 大致随 k 线性增长，
    于是 D(2)/D(1) ≈ 2。若帧顺序被打乱，相邻位置放的是本来不相邻的帧，
    D(1) 会被抬高，D(2)/D(1) 就明显掉下来。
实测：帧序正确的动图 D2/D1 在 1.58~1.80；帧序错乱的只有 1.29。区分度很干净，
且这个判据对「动作幅度大小」不敏感（慢动作、快动作都适用）。

用法
────
    python check_action_flow.py                    # 检查 app/assets/cat 下全部动图
    python check_action_flow.py <目录或.webp> ...    # 指定检查对象
"""
import os, sys, glob
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(os.path.dirname(HERE), 'app', 'assets', 'cat')
G_THRESHOLD = 1.45      # D2/D1 低于它即判定帧序可疑（正确值实测 ≥1.58，错乱实测 1.29）

args = [a for a in sys.argv[1:] if not a.startswith('--')]
targets = []
if not args:
    targets = sorted(glob.glob(os.path.join(DEFAULT_DIR, 'cat-*.webp')))
else:
    for a in args:
        targets += sorted(glob.glob(os.path.join(a, 'cat-*.webp'))) if os.path.isdir(a) else [a]

if not targets:
    print('没找到要检查的动图'); sys.exit(1)


def load_masks(path):
    """读出每帧的猫体掩膜（alpha > 100）。按 n_frames 顺序取，天然不涉及文件名排序。"""
    im = Image.open(path)
    n = getattr(im, 'n_frames', 1)
    ms = []
    for i in range(n):
        im.seek(i)
        ms.append(np.asarray(im.convert('RGBA'))[:, :, 3] > 100)
    return ms, n


def diff(a, b):
    """两帧的「不像程度」= 掩膜异或占并集的比例；0 表示完全一样"""
    u = np.logical_or(a, b).sum()
    return float(np.logical_xor(a, b).sum() / u) if u else 0.0


print(f'{"动图":22s} {"帧数":>4s} {"D1(相邻)":>9s} {"D2(隔1帧)":>9s} {"D2/D1":>7s}  判定')
print('-' * 74)
bad = []
for p in targets:
    ms, n = load_masks(p)
    if n < 4:
        print(f'{os.path.basename(p):22s} {n:4d}   帧数太少，跳过')
        continue
    # 含循环回接那一对，避免整段被漏掉
    D1 = float(np.mean([diff(ms[i], ms[i + 1]) for i in range(n - 1)] + [diff(ms[-1], ms[0])]))
    D2 = float(np.mean([diff(ms[i], ms[i + 2]) for i in range(n - 2)]))
    g = D2 / max(1e-9, D1)
    if D1 < 1e-4:
        verdict = '几乎静止，无需判断'
    elif g < G_THRESHOLD:
        verdict = '!! 帧序可疑（差异不随间隔增长）'
        bad.append(os.path.basename(p))
    else:
        verdict = '正常'
    print(f'{os.path.basename(p):22s} {n:4d} {D1:9.4f} {D2:9.4f} {g:7.2f}  {verdict}')

print(f'\n判读：D2/D1 应接近 2（差异随间隔大致线性增长）；低于 {G_THRESHOLD} 说明相邻帧之间的')
print('      差异被异常抬高 —— 典型原因是帧顺序被打乱（相邻位置放了本来不相邻的帧）。')
print('      注意：这检查的是「帧序」，不检查画面质量与尺度，那两项见 check_action_scale.py。')
if bad:
    print('\n需要关注: ' + '、'.join(bad))
