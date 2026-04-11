"""
SQLAlchemy engine and session factory for CookUp accounts.

- **Local dev:** leave ``DATABASE_URL`` unset to use SQLite at ``<project_root>/cookup.db``.
- **Production (Render Postgres):** set ``DATABASE_URL`` to the **Internal Database URL**
  from your Render Postgres dashboard (or link the DB so Render injects it). Never commit
  credentials; set them only in the Render dashboard or a local ``.env`` (gitignored).
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine.url import make_url
from collections.abc import Generator

from sqlalchemy.orm import Session, declarative_base, sessionmaker

_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _default_sqlite_url() -> str:
    p = (_PROJECT_ROOT / "cookup.db").resolve()
    return f"sqlite:///{p.as_posix()}"


def resolve_database_url() -> str:
    raw = os.environ.get("DATABASE_URL", "").strip()
    if raw:
        return raw
    return _default_sqlite_url()


def _ensure_sqlite_parent_dir(database_url: str) -> None:
    """Create parent directory for file-based SQLite before the engine opens the file."""
    try:
        u = make_url(database_url)
    except Exception:
        return
    if u.get_backend_name() != "sqlite":
        return
    db = u.database
    if not db or db == ":memory:" or db.startswith("file::memory:"):
        return
    path = Path(db)
    if not path.is_absolute():
        path = (_PROJECT_ROOT / path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)


DATABASE_URL = resolve_database_url()
_ensure_sqlite_parent_dir(DATABASE_URL)


def _create_engine():
    url = DATABASE_URL
    kwargs: dict = {"pool_pre_ping": True}
    try:
        backend = make_url(url).get_backend_name()
    except Exception:
        backend = "sqlite"
    if backend == "sqlite":
        kwargs["connect_args"] = {"check_same_thread": False}
    return create_engine(url, **kwargs)


engine = _create_engine()


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, connection_record) -> None:
    """SQLite only: WAL and busy timeout. Postgres connections skip this."""
    if connection_record.dialect.name != "sqlite":
        return
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


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
