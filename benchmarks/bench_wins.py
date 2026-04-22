"""
Concurrent Win Increment — Lost Update Race
-------------------------------------------
Proves read-modify-write loses increments under concurrent writes,
and that the atomic SQL UPDATE fix eliminates the race.

Run from the project root: python benchmarks/bench_wins.py
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path

# Make backend importable when run from any directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.database import SessionLocal, init_db
from backend.auth import increment_wins_for_users
from backend.models import User

TRIALS = 20
TEST_USERNAME = "__bench_wins__"


def setup_test_user() -> int:
    """Return uid of the bench test user, creating it if needed, with wins reset to 0."""
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == TEST_USERNAME).first()
        if user is None:
            user = User(username=TEST_USERNAME, password_hash="x", wins=0)
            db.add(user)
            db.commit()
            db.refresh(user)
        else:
            user.wins = 0
            db.commit()
        return int(user.id)
    finally:
        db.close()


def reset_wins(uid: int) -> None:
    db = SessionLocal()
    try:
        user = db.get(User, uid)
        if user:
            user.wins = 0
            db.commit()
    finally:
        db.close()


def read_wins(uid: int) -> int:
    db = SessionLocal()
    try:
        user = db.get(User, uid)
        return int(user.wins) if user else -1
    finally:
        db.close()


def run_trial(uid: int) -> int:
    """Two threads call increment_wins_for_users simultaneously. Returns final wins."""
    reset_wins(uid)

    # Barrier ensures both threads attempt the increment at the same time
    barrier = threading.Barrier(2)

    def worker() -> None:
        db = SessionLocal()
        try:
            barrier.wait()
            increment_wins_for_users(db, [uid])
        finally:
            db.close()

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    return read_wins(uid)


def main() -> None:
    print("Initializing DB ...")
    init_db()

    uid = setup_test_user()
    print(f"Test user uid={uid}  Running {TRIALS} trials\n")

    correct = 0
    lost = 0
    for i in range(TRIALS):
        result = run_trial(uid)
        ok = result == 2
        if ok:
            correct += 1
        else:
            lost += 1
        tag = "OK" if ok else "LOST INCREMENT"
        print(f"  Trial {i + 1:2d}: wins={result}  [{tag}]")

    print()
    print(f"Results: {correct}/{TRIALS} correct (wins=2), {lost}/{TRIALS} lost increments")
    if lost == 0:
        print("PASS — atomic UPDATE fix is working correctly.")
    else:
        print(f"FAIL — {lost} lost increments detected (read-modify-write race present).")


if __name__ == "__main__":
    main()
