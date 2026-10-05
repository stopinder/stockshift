"""Opt-in local catalogue worker; default smoke command needs no credentials or network."""

import argparse
import time
from uuid import uuid4

from stockshift_worker import __version__


def main() -> int:
    parser = argparse.ArgumentParser(description="StockShift local catalogue worker")
    parser.add_argument("--version", action="version", version=__version__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Claim and execute at most one local job")
    mode.add_argument("--poll", action="store_true", help="Poll local jobs until interrupted")
    parser.add_argument("--poll-interval", type=float, default=2)
    args = parser.parse_args()
    if args.poll_interval < 0.1 or args.poll_interval > 60:
        parser.error("poll interval must be 0.1 to 60 seconds")
    if not (args.once or args.poll):
        print("StockShift worker ready. Use --once or --poll for local catalogue jobs.")
        return 0
    from stockshift_worker.jobs.gateway import LocalGateway, TransportError
    from stockshift_worker.jobs.runner import run_once

    gateway, worker_id = LocalGateway.from_env(), str(uuid4())
    try:
        while True:
            try:
                processed = run_once(gateway, worker_id)
            except TransportError:
                if args.once:
                    return 1
                processed = False
            if args.once:
                print("Local job processed." if processed else "No eligible local jobs.")
                return 0
            if not processed:
                time.sleep(args.poll_interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
