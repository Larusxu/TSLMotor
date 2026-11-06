"""TSL Viewer — PyQt6 entry point.

    python main.py             # real serial hardware
    python main.py --demo      # offline preview with synthetic telemetry
"""

from __future__ import annotations

import argparse
import sys

from tslviewer.app import run


def main() -> int:
    parser = argparse.ArgumentParser(description="TSL Viewer · TMC6460 Studio (PyQt6)")
    parser.add_argument("--demo", action="store_true", help="离线演示模式（合成遥测，不打开串口）")
    args = parser.parse_args()
    return run(demo=args.demo)


if __name__ == "__main__":
    sys.exit(main())
