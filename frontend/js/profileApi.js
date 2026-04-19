/** `/api/profile/*` helpers */
import { getApiBase } from "./apiOrigin.js";
import { apiFetch } from "./apiFetch.js";
import {
  authHeaders,
  authBearerOnly,
  authHeadersMultipart,
} from "./authApi.js";

export async function fetchProfile(username) {
  const base = getApiBase();
  const res = await apiFetch(
    `${base}/api/profile/${encodeURIComponent(username)}`,
  );
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || res.statusText || "Profile not found");
  }
  return res.json();
}

export async function fetchProfileComments(username, page = 1) {
  const base = getApiBase();
  const res = await apiFetch(
    `${base}/api/profile/${encodeURIComponent(username)}/comments?page=${page}`,
  );
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

export async function postProfileComment(username, content) {
  const base = getApiBase();
  const res = await apiFetch(
    `${base}/api/profile/${encodeURIComponent(username)}/comments`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.detail || res.statusText || "Failed to post comment");
  return data;
}

export async function deleteProfileComment(commentId) {
  const base = getApiBase();
  const res = await apiFetch(`${base}/api/profile/comments/${commentId}`, {
    method: "DELETE",
    headers: authBearerOnly(),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || "Failed to delete comment");
  }
  return res.json();
}

export async function updateBio(bio) {
  const base = getApiBase();
  const res = await apiFetch(`${base}/api/me/profile`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ bio }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || "Failed to update bio");
  }
  return res.json();
}

export async function uploadAvatar(file) {
  const base = getApiBase();
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch(`${base}/api/me/avatar`, {
    method: "POST",
    headers: authHeadersMultipart(),
    body: form,
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || "Failed to upload avatar");
  }
  return res.json();
}
