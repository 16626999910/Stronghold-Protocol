#!/usr/bin/env python3
"""extract-voice.py — 从游戏本体的角色语音 .ab 提取全部 AudioClip 为 WAV（按编号命名 cn_XXX.wav）。
供 tools/build-local-jp-voice.mjs 调用；also usable standalone。

用法: python extract-voice.py <ab-path> <out-dir>
输出: <out-dir>/cn_XXX.wav   (AudioClip 名 CN_XXX → 小写 cn_xxx)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main():
    if len(sys.argv) != 3:
        print('usage: extract-voice.py <ab-path> <out-dir>')
        return 2
    ab = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    if not ab.exists():
        print(f'missing: {ab}', file=sys.stderr)
        return 2
    import aklz4  # noqa: F401  registers LZ4AK decoder
    import UnityPy
    try:
        env = UnityPy.load(str(ab))
    except Exception as e:
        print(f'LOAD FAIL {ab}: {e}', file=sys.stderr)
        return 1
    n = 0
    for o in env.objects:
        if o.type.name != 'AudioClip':
            continue
        d = o.read()
        smp = d.samples  # {filename: bytes} 已解码为 WAV
        if not isinstance(smp, dict):
            continue
        for fname, data in smp.items():
            # fname 形如 'CN_020.wav' → 存为 'cn_020.wav'
            name = Path(fname).stem.lower()  # 'cn_020'
            if not name:
                continue
            (out / f'{name}.wav').write_bytes(data)
            n += 1
    if not n:
        print(f'no audio extracted from {ab.name}', file=sys.stderr)
        return 1
    print(f'{ab.name}: {n} wav')
    return 0


if __name__ == '__main__':
    sys.exit(main())