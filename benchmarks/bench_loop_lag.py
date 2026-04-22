"""
Event Loop Lag Monitor
----------------------
Measures asyncio event loop responsiveness under concurrent HTTP load.
Detects blocking operations (threading.Lock contention, sync I/O, heavy CPU)
that stall the event loop thread.

This tool first calibrates local scheduler/timer jitter, then reports adjusted lag.
Adjusted lag under ~2ms is healthy. Sustained spikes above ~5ms suggest blocking work.

Requires a running server.
Dependencies: pip install aiohttp

Usage:
    # Hammer auth endpoints to stress the lock path:
    python benchmarks/bench_loop_lag.py --mode hammer --url http://localhost:8000

    # Just watch lag while manually testing:
    python benchmarks/bench_loop_lag.py --mode watch --url http://localhost:8000
"""
from __future__ import annotations

import argparse
import asyncio
import statistics
import time

try:
    import aiohttp
except ImportError:
    print("Missing dependency: pip install aiohttp")
    raise SystemExit(1)

TICK_INTERVAL_S = 0.05  # measure lag every 50ms
REPORT_EVERY = 40       # print report every 2 seconds (40 × 50ms)
N_CONCURRENT = 50       # simultaneous persistent hammer workers
BASELINE_SECONDS = 6.0  # local timer jitter calibration before reporting
HEALTHY_MAX_MS = 2.0
WARN_MAX_MS = 5.0


async def lag_monitor(results: list[float]) -> None:
    """Measure how late each 50ms tick fires."""
    while True:
        expected = time.perf_counter() + TICK_INTERVAL_S
        await asyncio.sleep(TICK_INTERVAL_S)
        # Clamp to 0: Windows asyncio can fire slightly early
        lag_ms = max(0.0, (time.perf_counter() - expected) * 1000)
        results.append(lag_ms)


async def hammer_auth(url: str) -> None:
    """Flood /api/ws-ticket with bad tokens — each of N workers loops forever."""
    async with aiohttp.ClientSession() as session:
        async def one() -> None:
            while True:
                try:
                    async with session.post(
                        f"{url}/api/ws-ticket",
                        headers={"Authorization": "Bearer fake.token.here"},
                        timeout=aiohttp.ClientTimeout(total=2),
                    ):
                        pass
                except Exception:
                    pass

        await asyncio.gather(*[one() for _ in range(N_CONCURRENT)])


async def main(mode: str, url: str) -> None:
    lags: list[float] = []
    monitor_task = asyncio.create_task(lag_monitor(lags))

    baseline_samples = max(20, int(BASELINE_SECONDS / TICK_INTERVAL_S))
    print(
        f"Calibrating local event-loop baseline for {BASELINE_SECONDS:.0f}s "
        "(accounts for OS scheduler jitter)..."
    )
    while len(lags) < baseline_samples:
        await asyncio.sleep(TICK_INTERVAL_S)
    baseline_ms = statistics.median(lags[-baseline_samples:])
    print(f"Baseline p50: {baseline_ms:.1f}ms raw lag\n")

    if mode == "hammer":
        print(f"Hammering {url}/api/ws-ticket with {N_CONCURRENT} concurrent persistent workers...")
        print("Watching adjusted lag above calibrated baseline.\n")
        hammer_task = asyncio.create_task(hammer_auth(url))
    else:
        print("Watching event loop lag (no synthetic load). Connect players manually.")
        print("Adjusted lag should stay near 0-2ms on a healthy server.\n")
        hammer_task = None

    tick = 0
    try:
        while True:
            await asyncio.sleep(TICK_INTERVAL_S * REPORT_EVERY)
            tick += 1
            window = lags[-REPORT_EVERY:]
            if not window:
                continue
            adjusted = [max(0.0, x - baseline_ms) for x in window]
            p50 = statistics.median(adjusted)
            p95 = sorted(adjusted)[int(len(adjusted) * 0.95)]
            p99 = sorted(adjusted)[int(len(adjusted) * 0.99)]
            mx = max(adjusted)
            raw_p50 = statistics.median(window)
            spike_ratio = sum(1 for x in adjusted if x > WARN_MAX_MS) / len(adjusted)
            if p95 <= HEALTHY_MAX_MS and spike_ratio <= 0.02:
                status = "OK"
            elif p95 <= WARN_MAX_MS and spike_ratio <= 0.10:
                status = "WARN"
            else:
                status = "BLOCKED"
            print(
                f"[{tick * 2:>4}s] adj p50={p50:.1f}ms  p95={p95:.1f}ms  p99={p99:.1f}ms  "
                f"max={mx:.1f}ms  raw p50={raw_p50:.1f}ms  [{status}]"
            )
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        monitor_task.cancel()
        if hammer_task:
            hammer_task.cancel()
        try:
            await asyncio.gather(monitor_task, *([] if hammer_task is None else [hammer_task]), return_exceptions=True)
        except Exception:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Monitor asyncio event loop lag under HTTP load.")
    parser.add_argument("--mode", choices=["watch", "hammer"], default="watch")
    parser.add_argument("--url", default="http://localhost:8000")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.mode, args.url.rstrip("/")))
    except KeyboardInterrupt:
        pass
