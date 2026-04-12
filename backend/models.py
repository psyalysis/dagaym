"""
SQLAlchemy ORM models.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    wins: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class SiteStats(Base):
    """Singleton row (id=1): aggregate site counters."""

    __tablename__ = "site_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    total_visits: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
