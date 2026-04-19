"""
Transactional profile-icon purchase (beatbucks / users.coins).
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import invalidate_user_cache
from .models import User, UserProfileIconOwnership
from .shop_catalog import is_valid_icon_key, price_for_icon


def purchase_profile_icon(db: Session, user_id: int, icon_key: str) -> tuple[int, str | None]:
    """
    Deduct coins, record ownership, equip icon. Returns (new_coins, equipped_icon_key).
    Raises HTTPException on validation / balance / duplicate.
    """
    if not is_valid_icon_key(icon_key):
        raise HTTPException(status_code=400, detail="Unknown profile icon.")

    price = price_for_icon(icon_key)

    locked = db.query(User).filter(User.id == user_id).with_for_update().one_or_none()
    if locked is None:
        raise HTTPException(status_code=401, detail="User not found.")

    if locked.coins < price:
        raise HTTPException(
            status_code=400,
            detail="Insufficient beatbucks.",
        )

    existing = (
        db.query(UserProfileIconOwnership)
        .filter(
            UserProfileIconOwnership.user_id == user_id,
            UserProfileIconOwnership.icon_key == icon_key,
        )
        .first()
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="Already owned.")

    locked.coins -= price
    locked.profile_icon_key = icon_key
    db.add(UserProfileIconOwnership(user_id=user_id, icon_key=icon_key))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Already owned.") from None

    invalidate_user_cache(user_id)
    return locked.coins, locked.profile_icon_key
