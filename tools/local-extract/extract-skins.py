#!/usr/bin/env python3
"""extract-skins.py — 从游戏本体 skinpack/<charId>.ab 提取一款皮肤的前/后 Spine 模型。

干员皮肤包内含它所有皮肤的前(Front)/后(Back)骨架。每个皮肤有多个 SkeletonDataAsset
（同一皮肤的不同名字/构建副本）。本脚本按 prefabId（如 `char_003_kalts_boc#6`）匹配其
SkeletonDataAsset（`m_Name` = `<prefabId>_SkeletonData`），用 extract.py 的 write_spine
提取骨架+atlas+贴图到 <out>/<stem>/{front,back}/，并把贴图与 atlas 页面名统一为
<stem>.png（fetch 管线的皮肤文件命名：<stem>.skel/.atlas/.png，页面名下无 #@）。

用法: python extract-skins.py <ab-path> <prefabId> <out-root>
输出: <out-root>/<stem>/{front,back}/<stem>.skel|.atlas|<stem>.png
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util
spec = importlib.util.spec_from_file_location('extractmod', str(Path(__file__).resolve().parent / 'extract.py'))
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)


def main():
    if len(sys.argv) != 4:
        print('usage: extract-skins.py <ab-path> <prefabId> <out-root>', file=sys.stderr)
        return 2
    ab, prefab, out_root = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    if not ab.exists():
        print(f'missing: {ab}', file=sys.stderr)
        return 2
    out_root.mkdir(parents=True, exist_ok=True)
    sda_name = f'{prefab}_SkeletonData'
    import aklz4  # noqa: F401
    import UnityPy
    try:
        env = UnityPy.load(str(ab))
    except Exception as e:
        print(f'LOAD FAIL {ab}: {e}', file=sys.stderr)
        return 1
    objects = {o.path_id: o for o in env.objects}
    # 本皮肤的全部 SkeletonDataAsset typetree（name 相同但 atlas path id 不同 = front/back 副本）
    tts = []
    seen = set()
    for o in env.objects:
        if o.type.name != 'MonoBehaviour':
            continue
        try:
            tt = o.read_typetree()
        except Exception:
            continue
        if 'skeletonJSON' not in tt or 'atlasAssets' not in tt:
            continue
        nm = tt.get('m_Name') or ''
        if nm == sda_name and not nm.startswith('build_'):
            key = (tt.get('atlasAssets') or [{}])[0].get('m_PathID')
            if key not in seen:
                seen.add(key)
                tts.append(tt)
    if not tts:
        print(f'{sda_name}: 未找到 SkeletonDataAsset', file=sys.stderr)
        return 1
    stem = prefab.replace('#', '_').replace('@', '_')
    got_front = got_back = False
    total = 0
    for side, tt in zip(['front', 'back'], tts):
        # write_spine 输出到 <out_root>/<sub>；out_root 已是 .../op/<charId>/<stem>，所以 sub = side
        sub = side
        manifest = {}
        logs = []
        k = 0
        try:
            k = ex.write_spine(objects, tt, sub, stem, out_root, manifest, lambda m: logs.append(m))
        except Exception as e:
            print(f'  warn {side}: {e}', file=sys.stderr)
        if k:
            total += k
            if side == 'front':
                got_front = True
            else:
                got_back = True
        else:
            print(f'  warn {side}: 无输出 ({"; ".join(logs) or "?"})', file=sys.stderr)
    if not total or not got_front:
        print(f'{prefab}: front 缺失', file=sys.stderr)
        return 1
    # 统一命名: PNG → <stem>.png, atlas 页面名 → <stem>.png
    for side in ('front', 'back'):
        d = out_root / side
        if not d.exists():
            continue
        for png in list(d.glob('*.png')):
            if png.name != f'{stem}.png':
                png.rename(d / f'{stem}.png')
        atlas_p = d / f'{stem}.atlas'
        if atlas_p.exists():
            txt = atlas_p.read_text(encoding='utf-8', errors='replace')
            txt2 = re.sub(r'^(.*\.png)\s*$', f'{stem}.png', txt, count=1, flags=re.M)
            atlas_p.write_text(txt2, encoding='utf-8')
    print(f'{prefab}: {total} files -> {stem}/' + ('back ' if got_back else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())