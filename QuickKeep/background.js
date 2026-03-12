/**
 * QuickKeep — background.js (Service Worker)
 *
 * Saves entries directly to Firestore via REST API.
 * This allows content script saves to work even when
 * the popup is closed.
 */

const PROJECT_ID = "quickkeep-57a5e";
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ── Get auth token for current user ──────────────────────────
async function getAuthToken() {
  const data = await chrome.storage.local.get([
    "qk_auth_token",
    "qk_auth_expiry",
  ]);
  if (data.qk_auth_token && data.qk_auth_expiry > Date.now()) {
    return data.qk_auth_token;
  }
  return null;
}

// ── Get user profile from storage ────────────────────────────
async function getUserData() {
  const data = await chrome.storage.local.get([
    "qk_user_uid",
    "qk_user_plan",
    "qk_auth_token",
    "qk_auth_expiry",
  ]);
  return data;
}

// ── Count user's existing entries via Firestore REST ─────────
async function countUserEntries(uid, token) {
  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: "entries" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "userId" },
          op: "EQUAL",
          value: { stringValue: uid },
        },
      },
      select: {
        fields: [{ fieldPath: "__name__" }], // only fetch doc names, not full data
      },
    },
  };

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(queryBody),
    },
  );

  const data = await res.json();
  // runQuery returns an array — filter out empty results
  return data.filter((d) => d.document).length;
}

// ── Save entry to Firestore via REST ─────────────────────────
async function saveToFirestore(uid, plan, url, title, note, token) {
  // Enforce free plan limit of 20 entries
  if (plan === "free") {
    const count = await countUserEntries(uid, token);
    if (count >= 20) {
      throw new Error("FREE_LIMIT_REACHED");
    }
  }

  const now = new Date().toISOString();
  const body = {
    fields: {
      userId: { stringValue: uid },
      teamId: { nullValue: null },
      url: { stringValue: url },
      title: { stringValue: title || "Untitled" },
      note: { stringValue: note || "" },
      folderId: { nullValue: null },
      tags: { nullValue: null },
      savedAt: { timestampValue: now },
      updatedAt: { timestampValue: now },
    },
  };

  // Check if URL already exists — update note instead of duplicate
  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: "entries" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "userId" },
                op: "EQUAL",
                value: { stringValue: uid },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "url" },
                op: "EQUAL",
                value: { stringValue: url },
              },
            },
          ],
        },
      },
      limit: 1,
    },
  };

  const queryRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(queryBody),
    },
  );

  const queryData = await queryRes.json();
  const existing = queryData[0]?.document;

  if (existing) {
    // Update note on existing entry
    const docName = existing.name;
    await fetch(
      `${docName}?updateMask.fieldPaths=note&updateMask.fieldPaths=updatedAt`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: {
            note: { stringValue: note || "" },
            updatedAt: { timestampValue: now },
          },
        }),
      },
    );
  } else {
    // Create new entry
    await fetch(`${FIRESTORE_URL}/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}

// ── Save to local storage (guest mode) ───────────────────────
async function saveToLocal(url, title, note) {
  const data = await chrome.storage.local.get(["quickkeep_entries"]);
  const entries = data.quickkeep_entries || [];
  const existingIdx = entries.findIndex((e) => e.url === url);

  if (existingIdx > -1) {
    entries[existingIdx].note = note;
    entries[existingIdx].savedAt = Date.now();
  } else {
    const genUid = () =>
      Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    entries.unshift({ id: genUid(), url, title, note, savedAt: Date.now() });
  }

  await chrome.storage.local.set({ quickkeep_entries: entries });
}

// ── Message handler ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_PAGE") {
    const { url, title, note } = msg;

    getUserData().then(async (userData) => {
      const { qk_user_uid, qk_user_plan, qk_auth_token, qk_auth_expiry } =
        userData;

      const isLoggedIn =
        qk_user_uid && qk_auth_token && qk_auth_expiry > Date.now();

      try {
        if (isLoggedIn) {
          await saveToFirestore(
            qk_user_uid,
            qk_user_plan || "free",
            url,
            title,
            note,
            qk_auth_token,
          );
        } else {
          await saveToLocal(url, title, note);
        }
        sendResponse({ ok: true });
      } catch (err) {
        console.error("[QuickKeep BG] Save error:", err);
        sendResponse({ ok: false, error: err.message });
      }
    });

    return true; // keep channel open for async response
  }
});
