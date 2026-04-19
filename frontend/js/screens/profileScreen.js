/** /@username — card, bio if it's you, comments for everyone */
import { isLoggedIn, getUsername } from "../authApi.js";
import {
  fetchProfile,
  fetchProfileComments,
  postProfileComment,
  deleteProfileComment,
  updateBio,
} from "../profileApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { escapeHtml, rankBadgeHtml } from "../rankUi.js";
import { supporterDisplayNameInnerHtml } from "../supporters.js";
import { mountAuthCornerMenu, mountAuthCornerGuest } from "../authCorner.js";
import { playSfxMinor } from "../sfx.js";
import { mountModeSelectScreen } from "./modeSelect.js";

function _relativeTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function _formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function _commentHtml(c, isOwnOrDev) {
  const badge = rankBadgeHtml(c.author_rank);
  const nameHtml = supporterDisplayNameInnerHtml(c.author_username);
  const avatarChar = escapeHtml(
    (c.author_username || "?").charAt(0).toUpperCase(),
  );
  const avatarInner = c.author_avatar_url
    ? `<img class="profile-comment-avatar-img" src="${escapeHtml(c.author_avatar_url)}" alt="" />`
    : `<span class="profile-comment-avatar-letter">${avatarChar}</span>`;
  const deleteBtn = isOwnOrDev
    ? `<button type="button" class="profile-comment-delete" data-comment-id="${c.id}" aria-label="Delete comment">✕</button>`
    : "";
  return `
    <div class="profile-comment" data-comment-id="${c.id}">
      <div class="profile-comment-avatar">${avatarInner}</div>
      <div class="profile-comment-body">
        <div class="profile-comment-head">
          <span class="profile-comment-author name-with-rank" data-username="${escapeHtml(c.author_username)}">${badge}${nameHtml}</span>
          <span class="profile-comment-time">${_relativeTime(c.created_at)}</span>
          ${deleteBtn}
        </div>
        <div class="profile-comment-text">${escapeHtml(c.content)}</div>
      </div>
    </div>`;
}

export function mountProfileScreen(root, ctx) {
  const targetUsername = ctx.profileUsername || "";
  if (!targetUsername) {
    ctx.navigate(mountModeSelectScreen);
    return () => {};
  }

  setAppErrorContext({ screen: "Profile", user: targetUsername });

  const isOwn =
    isLoggedIn() &&
    getUsername().toLowerCase() === targetUsername.toLowerCase();
  const loggedIn = isLoggedIn();
  const myUsername = getUsername();

  root.innerHTML = `
    <div class="screen profile-screen arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="profile-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">PROFILE</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <p class="arcade-status" id="profile-status">Loading…</p>
      <div class="profile-content" id="profile-content" style="display:none">
        <div class="profile-card" id="profile-card"></div>
        <div class="profile-comments-section">
          <div class="profile-comments-header">
            <span class="profile-comments-title">COMMENTS</span>
            <span class="profile-comments-count" id="profile-comments-count"></span>
          </div>
          ${
            loggedIn
              ? `<div class="profile-comment-form">
                   <textarea class="arcade-input profile-comment-input" id="profile-comment-input" placeholder="Leave a comment…" maxlength="500" rows="2"></textarea>
                   <div class="profile-comment-form-footer">
                     <span class="profile-comment-chars" id="profile-comment-chars">0/500</span>
                     <button type="button" class="btn profile-comment-submit" id="profile-comment-submit" disabled>Post</button>
                   </div>
                 </div>`
              : `<p class="arcade-hint profile-login-hint">Log in to leave a comment.</p>`
          }
          <div class="profile-comments-list" id="profile-comments-list"></div>
          <p class="arcade-error" id="profile-comment-error"></p>
        </div>
      </div>
    </div>
  `;

  if (loggedIn) {
    mountAuthCornerMenu(ctx, { primary: "home" });
  } else {
    mountAuthCornerGuest(ctx, { showHome: true });
  }

  const statusEl = root.querySelector("#profile-status");
  const contentEl = root.querySelector("#profile-content");
  const cardEl = root.querySelector("#profile-card");
  const commentsList = root.querySelector("#profile-comments-list");
  const commentsCountEl = root.querySelector("#profile-comments-count");
  const commentInput = root.querySelector("#profile-comment-input");
  const commentSubmit = root.querySelector("#profile-comment-submit");
  const commentChars = root.querySelector("#profile-comment-chars");
  const commentError = root.querySelector("#profile-comment-error");

  root.querySelector("#profile-back")?.addEventListener("click", () => {
    playSfxMinor();
    if (ctx._prevScreen) {
      ctx.navigate(ctx._prevScreen);
    } else {
      ctx.navigate(mountModeSelectScreen);
    }
  });

  let profileData = null;
  let comments = [];

  async function loadProfile() {
    try {
      profileData = await fetchProfile(targetUsername);
      renderCard();
      if (statusEl) statusEl.textContent = "";
      if (contentEl) contentEl.style.display = "";
    } catch (e) {
      if (statusEl)
        statusEl.textContent = e.message || "Could not load profile.";
    }
  }

  async function loadComments() {
    try {
      comments = await fetchProfileComments(targetUsername);
      renderComments();
    } catch (e) {
      if (commentError) commentError.textContent = "Could not load comments.";
    }
  }

  function renderCard() {
    if (!profileData || !cardEl) return;
    const p = profileData;
    const badge = rankBadgeHtml(p.rank);
    const nameHtml = supporterDisplayNameInnerHtml(p.username);
    const avatarChar = escapeHtml(p.username.charAt(0).toUpperCase());
    const rankLabel = p.rank ? escapeHtml(p.rank.label) : "Unranked";
    const rankColor = p.rank ? p.rank.color : "var(--text-muted)";

    const avatarInner = p.avatar_url
      ? `<img class="profile-avatar-img" src="${escapeHtml(p.avatar_url)}" alt="${escapeHtml(p.username)}" />`
      : `<span class="profile-avatar-letter">${avatarChar}</span>`;

    const profileIconBadge = p.profile_icon_emoji
      ? `<span class="profile-card-icon-badge" title="Profile icon" aria-hidden="true">${escapeHtml(p.profile_icon_emoji)}</span>`
      : "";

    const bioLen = (p.bio || "").length;
    const bioHtml = isOwn
      ? `<div class="profile-bio-edit">
           <textarea class="profile-bio-input" id="profile-bio-input" placeholder="Write something about yourself…" maxlength="200">${escapeHtml(p.bio || "")}</textarea>
           <div class="profile-bio-footer">
             <span class="profile-bio-chars" id="profile-bio-chars">${bioLen}/200</span>
             <button type="button" class="btn profile-bio-save" id="profile-bio-save">Save</button>
           </div>
         </div>`
      : p.bio
        ? `<p class="profile-bio-text">${escapeHtml(p.bio)}</p>`
        : "";

    const profileRankHtml = p.rank
      ? `<div class="profile-rank-icon">${rankBadgeHtml(p.rank)}</div>`
      : "";

    cardEl.innerHTML = `
      <div class="profile-card-top">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar">${avatarInner}</div>
          ${profileIconBadge}
        </div>
        <div class="profile-card-info">
          <div class="profile-name name-with-rank">${nameHtml}</div>
          ${profileRankHtml}
        </div>
      </div>
      <div class="profile-card-body">
        <div class="profile-bio-col">
          ${bioHtml}
        </div>
        <div class="profile-stats-col">
          <div class="profile-stat">
            <span class="profile-stat-value">${p.wins}</span>
            <span class="profile-stat-label">WINS</span>
          </div>
          <div class="profile-stat">
            <span class="profile-stat-value">${p.games_played ?? 0}</span>
            <span class="profile-stat-label">PLAYED</span>
          </div>
        </div>
      </div>
    `;

    if (isOwn) {
      const bioInput = cardEl.querySelector("#profile-bio-input");
      const bioSave = cardEl.querySelector("#profile-bio-save");
      const bioChars = cardEl.querySelector("#profile-bio-chars");
      if (bioInput && bioChars) {
        bioInput.addEventListener("input", () => {
          bioChars.textContent = `${bioInput.value.length}/200`;
        });
      }
      if (bioSave && bioInput) {
        bioSave.addEventListener("click", async () => {
          bioSave.disabled = true;
          bioSave.textContent = "…";
          try {
            await updateBio(bioInput.value.trim());
            playSfxMinor();
            bioSave.textContent = "Saved!";
            setTimeout(() => (bioSave.textContent = "Save"), 1500);
          } catch (e) {
            bioSave.textContent = "Error";
            setTimeout(() => (bioSave.textContent = "Save"), 2000);
          } finally {
            bioSave.disabled = false;
          }
        });
      }
    }
  }

  function renderComments() {
    if (!commentsList) return;
    if (commentsCountEl) commentsCountEl.textContent = `(${comments.length})`;
    if (comments.length === 0) {
      commentsList.innerHTML = `<p class="arcade-hint">No comments yet.</p>`;
      return;
    }
    const isDev = loggedIn && ["psyalysis", "polystalgia"].includes(myUsername);
    commentsList.innerHTML = comments
      .map((c) => {
        const canDelete =
          (loggedIn && c.author_username === myUsername) || isDev;
        return _commentHtml(c, canDelete);
      })
      .join("");

    commentsList.querySelectorAll(".profile-comment-delete").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const id = Number(btn.dataset.commentId);
        if (!id) return;
        btn.disabled = true;
        try {
          await deleteProfileComment(id);
          comments = comments.filter((c) => c.id !== id);
          renderComments();
          playSfxMinor();
        } catch (e) {
          btn.disabled = false;
          if (commentError) commentError.textContent = e.message;
        }
      });
    });

    commentsList.querySelectorAll(".profile-comment-author").forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        const u = el.dataset.username;
        if (u && u.toLowerCase() !== targetUsername.toLowerCase()) {
          playSfxMinor();
          navigateToProfile(u);
        }
      });
    });
  }

  function navigateToProfile(username) {
    history.pushState({ profile: username }, "", `/@${username}`);
    ctx.navigate(mountProfileScreen, {
      profileUsername: username,
      _prevScreen: mountProfileScreen,
      skipPanelEnterTransition: true,
    });
  }

  if (commentInput && commentSubmit && commentChars) {
    commentInput.addEventListener("input", () => {
      const len = commentInput.value.trim().length;
      commentChars.textContent = `${len}/500`;
      commentSubmit.disabled = len === 0 || len > 500;
    });

    commentSubmit.addEventListener("click", async () => {
      const content = commentInput.value.trim();
      if (!content) return;
      commentSubmit.disabled = true;
      commentSubmit.textContent = "…";
      if (commentError) commentError.textContent = "";
      try {
        const newComment = await postProfileComment(targetUsername, content);
        comments.unshift(newComment);
        renderComments();
        commentInput.value = "";
        commentChars.textContent = "0/500";
        playSfxMinor();
      } catch (e) {
        if (commentError) commentError.textContent = e.message;
      } finally {
        commentSubmit.disabled = false;
        commentSubmit.textContent = "Post";
      }
    });
  }

  loadProfile();
  loadComments();

  const onPopState = (ev) => {
    const state = ev.state;
    if (state && state.profile) {
      ctx.navigate(mountProfileScreen, {
        profileUsername: state.profile,
        _prevScreen: mountProfileScreen,
        skipPanelEnterTransition: true,
      });
    }
  };
  window.addEventListener("popstate", onPopState);

  return () => {
    window.removeEventListener("popstate", onPopState);
    const pathMatch = window.location.pathname.match(/^\/@([^/]+)/);
    if (
      pathMatch &&
      decodeURIComponent(pathMatch[1]).toLowerCase() ===
        targetUsername.toLowerCase()
    ) {
      history.replaceState(null, "", "/");
    }
    root.innerHTML = "";
  };
}
