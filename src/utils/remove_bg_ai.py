#!/usr/bin/env python3
"""
remove_bg_ai.py
Usage: python3 remove_bg_ai.py <input_path> <output_path> [model_name]

rembg AI 배경 제거.
model_name: u2net (default), isnet-general-use, birefnet-general 등
"""
import sys
from rembg import remove, new_session
from PIL import Image


def main():
    if len(sys.argv) < 3:
        print("Usage: remove_bg_ai.py <input_path> <output_path> [model_name]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) >= 4 else "u2net"

    session = new_session(model_name)
    img = Image.open(input_path)
    result = remove(img, session=session)
    result.save(output_path)
    print(f"output={output_path}")


if __name__ == "__main__":
    main()
