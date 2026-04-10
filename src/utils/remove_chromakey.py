#!/usr/bin/env python3
"""
remove_chromakey.py

두 가지 모드:

1. 자동 색상 분석 모드 (pick 서브커맨드)
   Usage: python3 remove_chromakey.py pick <image_path>
   → 캐릭터 이미지를 분석해서 캐릭터 색상과 가장 멀리 떨어진
     크로마키 색상을 자동 선택하고 "r g b" 형태로 출력.

2. 배경 제거 모드 (remove 서브커맨드)
   Usage: python3 remove_chromakey.py remove <input> <output> <r> <g> <b> [threshold]
   → 이미지 엣지에서 BFS flood-fill로 해당 색상 제거 → 투명 PNG 저장.
"""
import sys
import numpy as np
from PIL import Image
from collections import deque

# 후보 크로마키 색상 (원색 계열 — 최대한 순수한 단색)
CANDIDATE_COLORS: list[tuple[int, int, int]] = [
    (255,   0, 255),  # magenta
    (  0, 255,   0),  # lime
    (  0, 255, 255),  # cyan
    (255, 255,   0),  # yellow
    (  0,   0, 255),  # blue
    (255,   0,   0),  # red
    (  0, 128, 255),  # azure
    (255, 128,   0),  # orange
]


def pick_chroma_color(image_path: str) -> tuple[int, int, int]:
    """
    캐릭터 이미지를 분석해 가장 안전한 크로마키 색상을 반환.
    - 불투명 픽셀만 샘플링 (투명 픽셀 제외)
    - 각 후보 색상에 대해 캐릭터 픽셀들과의 최소 거리 계산
    - 최소 거리가 가장 큰 후보 = 캐릭터에 가장 안 쓰인 색상 선택
    """
    img = Image.open(image_path).convert("RGBA")
    data = np.array(img, dtype=np.float32)

    # 불투명 픽셀만 추출 (알파 > 10)
    alpha = data[:, :, 3]
    opaque_mask = alpha > 10
    pixels = data[opaque_mask, :3]  # RGB만 (N, 3)

    if len(pixels) == 0:
        return CANDIDATE_COLORS[0]

    # 성능을 위해 최대 10,000픽셀 랜덤 샘플링
    if len(pixels) > 10_000:
        idx = np.random.choice(len(pixels), 10_000, replace=False)
        pixels = pixels[idx]

    best_color = CANDIDATE_COLORS[0]
    best_min_dist = -1.0

    for candidate in CANDIDATE_COLORS:
        cr, cg, cb = candidate
        # 모든 픽셀과 후보 색상 사이의 유클리드 거리 (벡터 연산)
        diff = pixels - np.array([cr, cg, cb], dtype=np.float32)
        dists = np.sqrt((diff ** 2).sum(axis=1))
        min_dist = float(dists.min())

        if min_dist > best_min_dist:
            best_min_dist = min_dist
            best_color = candidate

    return best_color


def remove_chromakey(input_path: str, output_path: str, target_rgb: tuple, threshold: float = 35.0):
    """
    이미지에서 크로마키 색상을 flood-fill 방식으로 제거하고 투명 PNG로 저장.
    """
    img = Image.open(input_path).convert("RGBA")
    data = np.array(img, dtype=np.uint8)
    h, w = data.shape[:2]

    tr, tg, tb = target_rgb
    visited = np.zeros((h, w), dtype=bool)
    queue = deque()

    def is_chroma(y: int, x: int) -> bool:
        r, g, b = int(data[y, x, 0]), int(data[y, x, 1]), int(data[y, x, 2])
        dist = ((r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2) ** 0.5
        return dist <= threshold

    # 4면 엣지에서 시드 설정
    for x in range(w):
        for y_edge in (0, h - 1):
            if not visited[y_edge, x] and is_chroma(y_edge, x):
                visited[y_edge, x] = True
                queue.append((y_edge, x))
    for y in range(h):
        for x_edge in (0, w - 1):
            if not visited[y, x_edge] and is_chroma(y, x_edge):
                visited[y, x_edge] = True
                queue.append((y, x_edge))

    # BFS flood-fill
    while queue:
        y, x = queue.popleft()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and is_chroma(ny, nx):
                visited[ny, nx] = True
                queue.append((ny, nx))

    # 배경 픽셀 알파 0으로
    data[visited, 3] = 0

    Image.fromarray(data).save(output_path)
    removed = int(visited.sum())
    print(f"removed={removed} output={output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]

    if mode == "pick":
        if len(sys.argv) < 3:
            print("Usage: remove_chromakey.py pick <image_path>", file=sys.stderr)
            sys.exit(1)
        r, g, b = pick_chroma_color(sys.argv[2])
        print(f"{r} {g} {b}")

    elif mode == "remove":
        if len(sys.argv) < 7:
            print("Usage: remove_chromakey.py remove <input> <output> <r> <g> <b> [threshold]", file=sys.stderr)
            sys.exit(1)
        _input  = sys.argv[2]
        _output = sys.argv[3]
        _r, _g, _b = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
        _threshold  = float(sys.argv[7]) if len(sys.argv) > 7 else 35.0
        remove_chromakey(_input, _output, (_r, _g, _b), _threshold)

    else:
        print(f"Unknown mode: {mode}. Use 'pick' or 'remove'.", file=sys.stderr)
        sys.exit(1)
