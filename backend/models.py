"""
SQLAlchemy ORM models.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    wins: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    games_played: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False, server_default="0"
    )
    coins: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default="0")
    bio: Mapped[str | None] = mapped_column(String(200), nullable=True, default=None)
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True, default=None)
    profile_icon_key: Mapped[str | None] = mapped_column(String(32), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    # Profile comments received on this user's profile
    profile_comments_received: Mapped[list["ProfileComment"]] = relationship(
        "ProfileComment",
        foreign_keys="ProfileComment.profile_id",
        back_populates="profile",
        cascade="all, delete-orphan",
    )
    # Profile comments this user has written
    profile_comments_written: Mapped[list["ProfileComment"]] = relationship(
        "ProfileComment",
        foreign_keys="ProfileComment.author_id",
        back_populates="author",
    )
    profile_icon_ownership: Mapped[list["UserProfileIconOwnership"]] = relationship(
        "UserProfileIconOwnership",
        back_populates="user",
        cascade="all, delete-orphan",
    )


class UserProfileIconOwnership(Base):
    """Purchased profile icons (beatbucks shop)."""

    __tablename__ = "user_profile_icon_ownership"
    __table_args__ = (UniqueConstraint("user_id", "icon_key", name="uq_user_profile_icon"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    icon_key: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    user: Mapped["User"] = relationship("User", back_populates="profile_icon_ownership")


class SiteStats(Base):
    """Singleton row (id=1): aggregate site counters."""

    __tablename__ = "site_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    total_visits: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    pause_new_matches: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default="0"
    )


class Supporter(Base):
    """Display names (lowercase key) for in-game supporter hearts; unique per normalized name."""

    __tablename__ = "supporters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name_key: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class ProfileComment(Base):
    """Comments left on a user's public profile."""

    __tablename__ = "profile_comments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    profile: Mapped["User"] = relationship(
        "User", foreign_keys=[profile_id], back_populates="profile_comments_received"
    )
    author: Mapped["User"] = relationship(
        "User", foreign_keys=[author_id], back_populates="profile_comments_written"
    )
