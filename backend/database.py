"""
SQLAlchemy engine: PostgreSQL (Neon) when DATABASE_URL is set, else local SQLite.
"""

from __future__ import annotations

import os
from collections.abc import Generator
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, declarative_base, sessionmaker

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_PROJECT_ROOT / ".env")


def _resolve_database_url() -> str:
    raw = os.environ.get("DATABASE_URL", "").strip()
    if not raw:
        return f"sqlite:///{_PROJECT_ROOT / 'cookup.db'}"
    # Heroku / some hosts use postgres://; SQLAlchemy expects postgresql://
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://") :]
    return raw


DATABASE_URL = _resolve_database_url()

_IS_SQLITE = DATABASE_URL.startswith("sqlite")

# PostgreSQL (e.g. Neon): pool defaults; override via env if you scale Render instances
# (each process has its own pool — total connections ≈ instances × (pool_size + max_overflow)).
def _pg_pool_kw() -> dict:
    pool_size = max(1, int(os.environ.get("COOKUP_DB_POOL_SIZE", "10")))
    max_overflow = max(0, int(os.environ.get("COOKUP_DB_MAX_OVERFLOW", "10")))
    pool_recycle = max(60, int(os.environ.get("COOKUP_DB_POOL_RECYCLE", "300")))
    pool_timeout = max(5, int(os.environ.get("COOKUP_DB_POOL_TIMEOUT", "30")))
    return {
        "pool_size": pool_size,
        "max_overflow": max_overflow,
        "pool_recycle": pool_recycle,
        "pool_timeout": pool_timeout,
    }


if _IS_SQLITE:
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        pool_pre_ping=True,
    )

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _connection_record) -> None:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()
else:
    # Neon: use the pooled connection string from the dashboard when possible.
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        connect_args={"connect_timeout": 10},
        **_pg_pool_kw(),
    )

Base = declarative_base()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables if missing."""
    from . import models  # noqa: F401 — register models

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        row = db.get(models.SiteStats, 1)
        if row is None:
            db.add(models.SiteStats(id=1, total_visits=0))
            db.commit()
        _seed_supporters_if_empty(db)
    finally:
        db.close()


def _seed_supporters_if_empty(db: Session) -> None:
    """One-time seed when the supporters table has no rows (Neon or SQLite)."""
    from . import models

    if db.query(models.Supporter).first() is not None:
        return
    initial = (
        "globagorb",
        "cowguts",
        "kdzfake",
        "originalmessgetter",
    )
    for k in initial:
        db.add(models.Supporter(name_key=k))
    db.commit()
