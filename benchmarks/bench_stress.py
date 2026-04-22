"""
Full WebSocket Load Test
------------------------
Registers real users, opens real WebSocket connections, creates/joins real lobbies,
and measures latency and error rates at scale.

Dependencies: pip install websockets httpx

Usage:
    python benchmarks/bench_stress.py --players 10  --lobby-size 5   # smoke test
    python benchmarks/bench_stress.py --players 50  --lobby-size 10  # light load
    python benchmarks/bench_stress.py --players 100 --lobby-size 10  # moderate
    python benchmarks/bench_stress.py --players 200 --lobby-size 10  # heavy
    python benchmarks/bench_stress.py --players 500 --lobby-size 10  # stress
"""
from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import statistics
import time
from collections import Counter, defaultdict
from typing import Any

try:
    import httpx
    import websockets
    import websockets.exceptions
except ImportError:
    print("Missing dependencies: pip install websockets httpx")
    raise SystemExit(1)

PASSWORD = "BenchPass123!"
# stressbot_<hex>_<n> — unique per run so reruns don't collide
RUN_PREFIX = f"sb_{secrets.token_hex(3)}"  # e.g. sb_a1b2c3  (9 chars)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

async def register(client: httpx.AsyncClient, username: str) -> bool:
    try:
        r = await client.post("/register", json={"username": username, "password": PASSWORD})
        return r.status_code in (200, 201, 400)  # 400 = already exists
    except Exception:
        return False


async def login(client: httpx.AsyncClient, username: str) -> str | None:
    try:
        r = await client.post("/login", json={"username": username, "password": PASSWORD})
        if r.status_code == 200:
            return r.json().get("token")
    except Exception:
        pass
    return None


async def get_ticket(client: httpx.AsyncClient, token: str) -> str | None:
    try:
        r = await client.post(
            "/api/ws-ticket",
            headers={"Authorization": f"Bearer {token}"},
        )
        if r.status_code == 200:
            return r.json().get("ticket")
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

class Metrics:
    def __init__(self) -> None:
        self.counts: dict[str, int] = defaultdict(int)
        self.latencies: dict[str, list[float]] = defaultdict(list)
        self.errors: list[str] = []

    def ok(self, stage: str, ms: float) -> None:
        self.counts[f"{stage}_ok"] += 1
        self.latencies[stage].append(ms)

    def fail(self, stage: str, reason: str = "") -> None:
        self.counts[f"{stage}_fail"] += 1
        if reason:
            self.errors.append(f"[{stage}] {reason[:120]}")

    def inc(self, key: str, n: int = 1) -> None:
        self.counts[key] += n

    def report(self, total_players: int) -> None:
        stages = ["register", "login", "ticket", "ws_connect", "lobby_join"]
        print("\n--- Stage results (latency in ms) ---")
        header = f"  {'stage':15s}  {'ok':>6}  {'fail':>6}  {'p50':>8}  {'p95':>8}  {'max':>8}"
        print(header)
        print("  " + "-" * (len(header) - 2))
        for stage in stages:
            ok = self.counts.get(f"{stage}_ok", 0)
            fail = self.counts.get(f"{stage}_fail", 0)
            lats = self.latencies.get(stage, [])
            if lats:
                p50 = statistics.median(lats)
                p95 = sorted(lats)[max(0, int(len(lats) * 0.95) - 1)]
                mx = max(lats)
                print(f"  {stage:15s}  {ok:6d}  {fail:6d}  {p50:8.0f}  {p95:8.0f}  {mx:8.0f}")
            else:
                print(f"  {stage:15s}  {ok:6d}  {fail:6d}  {'n/a':>8}  {'n/a':>8}  {'n/a':>8}")

        sent = self.counts.get("messages_sent", 0)
        recv = self.counts.get("messages_recv", 0)
        print(f"\n  Messages sent: {sent}  received: {recv}")

        if self.errors:
            print("\n--- Top errors ---")
            for msg, count in Counter(self.errors).most_common(10):
                print(f"  {count:4d}x  {msg}")

        ws_ok = self.counts.get("ws_connect_ok", 0)
        ws_fail = self.counts.get("ws_connect_fail", 0)
        join_fail = self.counts.get("lobby_join_fail", 0)

        print(f"\n--- Verdict ({total_players} players requested) ---")
        if ws_ok == 0:
            print("  FAIL — no players connected at all. Is the server running?")
        elif ws_ok == total_players and join_fail == 0:
            print(f"  PASS — all {ws_ok}/{total_players} players connected and joined lobbies.")
        else:
            print(f"  PARTIAL — {ws_ok}/{total_players} WS connected, {join_fail} lobby join failures, {ws_fail} WS failures.")
            if self.counts.get("ws_connect_fail", 0) > total_players * 0.1:
                print("  NOTE: >10% WS failures — check per-IP rate limiter (localhost may be throttled).")


# ---------------------------------------------------------------------------
# Player coroutine
# ---------------------------------------------------------------------------

async def run_player(
    flat_idx: int,
    is_creator: bool,
    lobby_id_future: asyncio.Future[str],
    metrics: Metrics,
    ws_url: str,
    client: httpx.AsyncClient,
    stay_s: int,
) -> None:
    username = f"{RUN_PREFIX}_{flat_idx:04d}"

    # Register (idempotent — 400 means already exists from a previous run)
    t0 = time.perf_counter()
    if not await register(client, username):
        metrics.fail("register", username)
        if is_creator and not lobby_id_future.done():
            lobby_id_future.set_exception(RuntimeError(f"{username}: register failed"))
        return
    metrics.ok("register", (time.perf_counter() - t0) * 1000)

    # Login
    t0 = time.perf_counter()
    token = await login(client, username)
    if not token:
        metrics.fail("login", username)
        if is_creator and not lobby_id_future.done():
            lobby_id_future.set_exception(RuntimeError(f"{username}: login failed"))
        return
    metrics.ok("login", (time.perf_counter() - t0) * 1000)

    # WS ticket
    t0 = time.perf_counter()
    ticket = await get_ticket(client, token)
    if not ticket:
        metrics.fail("ticket", username)
        if is_creator and not lobby_id_future.done():
            lobby_id_future.set_exception(RuntimeError(f"{username}: ticket failed"))
        return
    metrics.ok("ticket", (time.perf_counter() - t0) * 1000)

    # WebSocket connect
    t0 = time.perf_counter()
    try:
        async with websockets.connect(  # type: ignore[attr-defined]
            f"{ws_url}/ws?token={ticket}",
            open_timeout=10,
            close_timeout=5,
        ) as ws:
            metrics.ok("ws_connect", (time.perf_counter() - t0) * 1000)

            # Await the "connected" confirmation
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                msg: dict[str, Any] = json.loads(raw)
                metrics.inc("messages_recv")
            except (asyncio.TimeoutError, Exception) as e:
                metrics.fail("lobby_join", f"no connected msg: {e}")
                if is_creator and not lobby_id_future.done():
                    lobby_id_future.set_exception(RuntimeError(str(e)))
                return

            if msg.get("type") != "connected":
                metrics.fail("lobby_join", f"unexpected msg type: {msg.get('type')}")
                if is_creator and not lobby_id_future.done():
                    lobby_id_future.set_exception(RuntimeError("unexpected first msg"))
                return

            if is_creator:
                await _creator_flow(ws, username, lobby_id_future, metrics)
            else:
                await _joiner_flow(ws, username, lobby_id_future, metrics)

            # Stay connected and drain incoming messages
            drain_until = time.perf_counter() + stay_s
            while time.perf_counter() < drain_until:
                try:
                    await asyncio.wait_for(ws.recv(), timeout=0.2)
                    metrics.inc("messages_recv")
                except asyncio.TimeoutError:
                    continue
                except websockets.exceptions.ConnectionClosed:
                    break
                except Exception:
                    break

    except websockets.exceptions.InvalidStatus as e:
        metrics.fail("ws_connect", f"HTTP {e.response.status_code}")
        if is_creator and not lobby_id_future.done():
            lobby_id_future.set_exception(e)
    except Exception as e:
        metrics.fail("ws_connect", str(e))
        if is_creator and not lobby_id_future.done():
            lobby_id_future.set_exception(e)


async def _creator_flow(
    ws: Any,
    username: str,
    lobby_id_future: asyncio.Future[str],
    metrics: Metrics,
) -> None:
    t0 = time.perf_counter()
    await ws.send(json.dumps({
        "type": "create_lobby",
        "name": username,
        "spices": [0.5],
        "is_public": False,
    }))
    metrics.inc("messages_sent")

    # Server responds with player_join (contains lobby_id) + lobby_update
    deadline = time.perf_counter() + 5.0
    while time.perf_counter() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
            data: dict[str, Any] = json.loads(raw)
            metrics.inc("messages_recv")
            lid: str | None = data.get("lobby_id") or (data.get("lobby") or {}).get("id")
            if lid:
                if not lobby_id_future.done():
                    lobby_id_future.set_result(str(lid))
                metrics.ok("lobby_join", (time.perf_counter() - t0) * 1000)
                return
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            metrics.fail("lobby_join", f"creator recv error: {e}")
            if not lobby_id_future.done():
                lobby_id_future.set_exception(e)
            return

    if not lobby_id_future.done():
        lobby_id_future.set_exception(RuntimeError("creator: no lobby_id in server responses"))
    metrics.fail("lobby_join", "creator: no lobby_id received within 5s")


async def _joiner_flow(
    ws: Any,
    username: str,
    lobby_id_future: asyncio.Future[str],
    metrics: Metrics,
) -> None:
    try:
        lobby_id = await asyncio.wait_for(asyncio.shield(lobby_id_future), timeout=3.0)
    except asyncio.TimeoutError:
        metrics.fail("lobby_join", "joiner: timed out waiting for lobby_id from creator")
        return
    except Exception as e:
        metrics.fail("lobby_join", f"joiner: creator failed: {e}")
        return

    t0 = time.perf_counter()
    await ws.send(json.dumps({
        "type": "join_lobby",
        # join_lobby accepts either lobby_code or lobby_id; lobby_code works for both private/public
        "lobby_code": lobby_id,
        "name": username,
    }))
    metrics.inc("messages_sent")

    # Confirm join — any message proves we're in the lobby
    deadline = time.perf_counter() + 5.0
    joined = False
    while time.perf_counter() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
            data: dict[str, Any] = json.loads(raw)
            metrics.inc("messages_recv")
            t = data.get("type", "")
            if t in ("player_join", "lobby_update", "state_update", "joined_lobby", "error"):
                if t == "error":
                    metrics.fail("lobby_join", f"server error: {data.get('message', '')[:80]}")
                else:
                    metrics.ok("lobby_join", (time.perf_counter() - t0) * 1000)
                    joined = True
                return
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            metrics.fail("lobby_join", f"joiner recv error: {e}")
            return

    if not joined:
        metrics.fail("lobby_join", "joiner: no join confirmation within 5s")


# ---------------------------------------------------------------------------
# Lobby group orchestrator
# ---------------------------------------------------------------------------

async def run_lobby_group(
    group_idx: int,
    lobby_size: int,
    metrics: Metrics,
    ws_url: str,
    client: httpx.AsyncClient,
    stay_s: int,
) -> None:
    base_idx = group_idx * lobby_size
    lobby_id_future: asyncio.Future[str] = asyncio.get_event_loop().create_future()

    def _consume_future_exception(fut: asyncio.Future[str]) -> None:
        if fut.cancelled():
            return
        try:
            fut.exception()
        except Exception:
            pass

    lobby_id_future.add_done_callback(_consume_future_exception)

    # Creator starts 300ms before joiners to ensure the lobby exists
    creator = asyncio.create_task(
        run_player(base_idx, True, lobby_id_future, metrics, ws_url, client, stay_s)
    )
    await asyncio.sleep(0.3)
    joiners = [
        asyncio.create_task(
            run_player(base_idx + i, False, lobby_id_future, metrics, ws_url, client, stay_s)
        )
        for i in range(1, lobby_size)
    ]
    await asyncio.gather(creator, *joiners, return_exceptions=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(description="Stress test the Beat Battle backend.")
    p.add_argument("--players", type=int, default=10, help="Total concurrent players")
    p.add_argument("--lobby-size", type=int, default=5, help="Players per lobby")
    p.add_argument("--url", default="http://localhost:8000", help="Server base URL")
    p.add_argument("--stay", type=int, default=5, help="Seconds to stay connected per player")
    args = p.parse_args()

    base_url = args.url.rstrip("/")
    ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://")
    lobby_size = max(2, args.lobby_size)
    n_lobbies = max(1, args.players // lobby_size)
    total_players = n_lobbies * lobby_size

    print(f"Run prefix  : {RUN_PREFIX}")
    print(f"Server      : {base_url}")
    print(f"Players     : {total_players}  ({n_lobbies} lobbies × {lobby_size} players each)")
    print(f"Stay time   : {args.stay}s per connection")
    print(f"Usernames   : {RUN_PREFIX}_0000 … {RUN_PREFIX}_{total_players - 1:04d}")
    print()

    metrics = Metrics()

    async def _run() -> None:
        async with httpx.AsyncClient(base_url=base_url, timeout=15.0) as client:
            groups = [
                run_lobby_group(g, lobby_size, metrics, ws_url, client, args.stay)
                for g in range(n_lobbies)
            ]
            await asyncio.gather(*groups, return_exceptions=True)

    asyncio.run(_run())
    metrics.report(total_players)


if __name__ == "__main__":
    main()
