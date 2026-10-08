"""Durable worker daemon: drain current lease on SIGTERM; PostgreSQL recovers hard exits."""

import argparse
import signal
from threading import Event
from uuid import uuid4

from stockshift_worker import __version__


def serve(gateway, worker_id, stop, *, once=False, interval=2):
    from stockshift_worker.jobs.gateway import TransportError
    from stockshift_worker.jobs.runner import run_once

    while not stop.is_set():
        try:
            processed = run_once(gateway, worker_id)
        except TransportError:
            if once:
                return 1
            processed = False
            print("Worker transport unavailable; polling will retry.", flush=True)
        if once:
            print("Job processed." if processed else "No eligible jobs.", flush=True)
            return 0
        if not processed:
            stop.wait(interval)
    print("Worker stopped after draining current job.", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="StockShift durable catalogue worker")
    parser.add_argument("--version", action="version", version=__version__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Claim and execute at most one job")
    mode.add_argument("--poll", action="store_true", help="Poll until stopped (default)")
    mode.add_argument("--check", action="store_true", help="Check runtime imports without network")
    parser.add_argument("--poll-interval", type=float, default=2)
    args = parser.parse_args()
    if not 0.1 <= args.poll_interval <= 60:
        parser.error("poll interval must be 0.1 to 60 seconds")
    from stockshift_worker.jobs.gateway import gateway_from_env
    from stockshift_worker.jobs.runner import run_once  # noqa: F401

    if args.check:
        print("StockShift worker runtime imports ready.")
        return 0
    try:
        gateway = gateway_from_env()
    except ValueError as exc:
        parser.error(str(exc))
    stop = Event()
    previous = {}

    def shutdown(signum, frame):
        stop.set()  # No further claims; current job retains heartbeats until completion.

    for signum in (signal.SIGTERM, signal.SIGINT):
        previous[signum] = signal.signal(signum, shutdown)
    try:
        print("StockShift worker polling ready.", flush=True)
        return serve(gateway, str(uuid4()), stop, once=args.once, interval=args.poll_interval)
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())
