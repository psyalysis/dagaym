"""
Sequential vs Parallel WebSocket Broadcast Speedup
---------------------------------------------------
No server required — uses asyncio.sleep to simulate network RTT.

Run: python benchmarks/bench_broadcast.py
"""
from __future__ import annotations

import asyncio
import statistics
import time

PLAYERS = 10
LATENCY_MS = 30
RUNS = 20
COOK_PHASE_BROADCASTS = 600  # 10 min × 1 broadcast/sec


class FakeWS:
    def __init__(self, delay_s: float) -> None:
        self.delay_s = delay_s

    async def send_text(self, raw: str) -> None:
        await asyncio.sleep(self.delay_s)


async def broadcast_sequential(players: list[FakeWS], raw: str) -> float:
    t0 = time.perf_counter()
    for ws in players:
        await ws.send_text(raw)
    return (time.perf_counter() - t0) * 1000


async def broadcast_parallel(players: list[FakeWS], raw: str) -> float:
    t0 = time.perf_counter()
    coros = [ws.send_text(raw) for ws in players]
    await asyncio.gather(*coros, return_exceptions=True)
    return (time.perf_counter() - t0) * 1000


async def main() -> None:
    players = [FakeWS(LATENCY_MS / 1000) for _ in range(PLAYERS)]
    msg = '{"type":"timer_tick","remaining":595}'

    print(f"Players: {PLAYERS}  Simulated RTT per player: {LATENCY_MS}ms  Runs: {RUNS}")
    print()

    seq_times: list[float] = []
    for _ in range(RUNS):
        seq_times.append(await broadcast_sequential(players, msg))

    par_times: list[float] = []
    for _ in range(RUNS):
        par_times.append(await broadcast_parallel(players, msg))

    seq_p50 = statistics.median(seq_times)
    par_p50 = statistics.median(par_times)
    speedup = seq_p50 / par_p50 if par_p50 > 0 else float("inf")
    overhead_per_broadcast_ms = seq_p50 - par_p50
    total_wasted_s = overhead_per_broadcast_ms * COOK_PHASE_BROADCASTS / 1000

    print(f"Sequential  p50: {seq_p50:7.1f} ms")
    print(f"Parallel    p50: {par_p50:7.1f} ms")
    print(f"Speedup:         {speedup:.1f}x")
    print()
    print(f"Over a 10-min cook phase ({COOK_PHASE_BROADCASTS} broadcasts):")
    print(f"  Extra latency if sequential: {total_wasted_s:.1f}s wasted waiting on sends")

    if speedup >= 5:
        print("\nPASS — parallel broadcast is substantially faster (fix is working).")
    else:
        print("\nWARN — expected ~10x speedup with 10 players at 30ms RTT each.")


if __name__ == "__main__":
    asyncio.run(main())
