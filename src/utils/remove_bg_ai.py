#!/usr/bin/env python3
"""
remove_bg_ai.py
Usage: python3 remove_bg_ai.py <input_path> <output_path>

rembg (U2Net) 기반 AI 배경 제거.
배경 색상과 무관하게 전경(캐릭터/객체)을 분리하여 투명 PNG로 저장.
"""
import sys
from rembg import remove
from PIL import Image


def main():
    if len(sys.argv) < 3:
        print("Usage: remove_bg_ai.py <input_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    img = Image.open(input_path)
    result = remove(img)
    result.save(output_path)
    print(f"output={output_path}")


if __name__ == "__main__":
    main()
