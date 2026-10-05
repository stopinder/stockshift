"""No-op development CLI: starts no jobs and makes no network connections."""

import argparse

from stockshift_worker import __version__


def main() -> int:
    parser = argparse.ArgumentParser(description="StockShift worker foundation")
    parser.add_argument("--version", action="version", version=__version__)
    parser.parse_args()
    print("StockShift worker scaffold ready. No processing handlers are installed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
