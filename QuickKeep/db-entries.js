/**
 * QuickKeep — db-entries.js
 *
 * All Firestore database operations.
 * Replaces the entire Express backend routes.
 *
 * The extension calls these functions directly —
 * no HTTP server or API needed.
 */

const FREE_LIMIT = 20;

// ═══════════════════════════════════════════════════
//  ENTRIES
// ═══════════════════════════════════════════════════

// ── Fetch all personal entries for a user ─────────────────────
async function fetchEntries(uid) {
  const snap = await db
    .collection("entries")
    .where("userId", "==", uid)
    .where("teamId", "==", null)
    .orderBy("savedAt", "desc")
    .get();

  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ── Save a new entry (or update note if URL exists) ───────────
async function saveEntry(
  uid,
  plan,
  { url, title, note, folderId = null, tags = null, teamId = null },
) {
  // Only enforce free tier limit for personal saves
  if (plan === "free" && !teamId) {
    const snap = await db
      .collection("entries")
      .where("userId", "==", uid)
      .where("teamId", "==", null)
      .get();
    if (snap.size >= FREE_LIMIT) {
      throw {
        code: "LIMIT_REACHED",
        upgrade: true,
        message: `Free plan is limited to ${FREE_LIMIT} saves. Upgrade to Pro for unlimited.`,
      };
    }
  }

  // Check if URL already saved — update note if so
  const existing = await db
    .collection("entries")
    .where("userId", "==", uid)
    .where("url", "==", url)
    .limit(1)
    .get();

  if (!existing.empty) {
    const ref = existing.docs[0].ref;
    await ref.update({
      note: note || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return { id: ref.id, updated: true };
  }

  // Pro-only fields — strip for free users
  const safeFolder = plan !== "free" ? folderId : null;
  const safeTags = plan !== "free" ? tags : null;

  const ref = await db.collection("entries").add({
    userId: uid,
    teamId: teamId || null,
    url,
    title: title || "Untitled",
    note: note || "",
    folderId: safeFolder,
    tags: safeTags,
    savedByEmail: teamId ? window._qkUserEmail || "" : null,
    reactions: teamId
      ? { mustsave: [], meh: [], mindblown: [], watching: [] }
      : null,
    savedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  return { id: ref.id, updated: false };
}

// ── Update entry note ─────────────────────────────────────────
async function updateEntry(entryId, { note, folderId, tags }) {
  const updates = {
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  if (note !== undefined) updates.note = note;
  if (folderId !== undefined) updates.folderId = folderId;
  if (tags !== undefined) updates.tags = tags;
  await db.collection("entries").doc(entryId).update(updates);
}

// ── Delete a single entry ─────────────────────────────────────
async function deleteEntry(entryId) {
  await db.collection("entries").doc(entryId).delete();
}

// ── Clear all personal entries for a user ─────────────────────
async function clearAllEntries(uid) {
  const snap = await db
    .collection("entries")
    .where("userId", "==", uid)
    .where("teamId", "==", null)
    .get();

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

// ── Search entries (Pro — client-side full text on fetched data)
// Firestore doesn't do full-text natively, so we filter in-memory.
// For large datasets you'd integrate Algolia, but this is fine at small scale.
function searchEntries(entries, query) {
  const q = query.toLowerCase().trim();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      (e.title || "").toLowerCase().includes(q) ||
      (e.note || "").toLowerCase().includes(q) ||
      (e.url || "").toLowerCase().includes(q) ||
      (e.tags || []).some((t) => t.toLowerCase().includes(q)),
  );
}

// ── Export entries (Pro) ──────────────────────────────────────
function exportAsCSV(entries) {
  const header = "title,url,note,tags,saved_at\n";
  const rows = entries
    .map(
      (e) =>
        `"${(e.title || "").replace(/"/g, '""')}","${e.url}","${(e.note || "").replace(/"/g, '""')}","${(e.tags || []).join(";")}","${e.savedAt?.toDate?.() || ""}"`,
    )
    .join("\n");
  return header + rows;
}

function exportAsJSON(entries) {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      entries: entries.map((e) => ({
        title: e.title,
        url: e.url,
        note: e.note,
        tags: e.tags,
        savedAt: e.savedAt?.toDate?.()?.toISOString() || null,
      })),
    },
    null,
    2,
  );
}

function exportAsMarkdown(entries) {
  const lines = entries
    .map(
      (e) =>
        `## [${e.title || "Untitled"}](${e.url})\n${e.note ? `> ${e.note}\n` : ""}_Saved: ${e.savedAt?.toDate?.()?.toDateString() || "Unknown"}_`,
    )
    .join("\n\n---\n\n");
  return `# QuickKeep Export\n_Exported: ${new Date().toDateString()}_\n\n${lines}`;
}

// Helper: trigger a file download from the extension popup
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════
//  FOLDERS (Pro)
// ═══════════════════════════════════════════════════

async function fetchFolders(uid) {
  const snap = await db
    .collection("folders")
    .where("userId", "==", uid)
    .orderBy("name")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function createFolder(uid, { name, color = null }) {
  const ref = await db.collection("folders").add({
    userId: uid,
    name,
    color,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
}

async function deleteFolder(folderId) {
  await db.collection("folders").doc(folderId).delete();
  // Unlink entries from this folder
  const snap = await db
    .collection("entries")
    .where("folderId", "==", folderId)
    .get();
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.update(doc.ref, { folderId: null }));
  await batch.commit();
}

// ═══════════════════════════════════════════════════
//  TEAMS (Team plan)
// ═══════════════════════════════════════════════════

// Fetch team's shared entries
async function fetchTeamEntries(teamId) {
  const snap = await db
    .collection("entries")
    .where("teamId", "==", teamId)
    .orderBy("savedAt", "desc")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Save to shared team collection
async function saveTeamEntry(uid, teamId, { url, title, note }) {
  const ref = await db.collection("entries").add({
    userId: uid,
    teamId,
    url,
    title: title || "Untitled",
    note: note || "",
    savedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
}

// Fetch comments on a team entry
async function fetchComments(entryId) {
  const snap = await db
    .collection("comments")
    .where("entryId", "==", entryId)
    .orderBy("createdAt", "asc")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Add a comment
async function addComment(uid, entryId, body) {
  const ref = await db.collection("comments").add({
    entryId,
    userId: uid,
    body,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
}

// Send a team invite (writes an invite document)
async function sendInvite(teamId, email) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await db.collection("invites").add({
    teamId,
    email: email.toLowerCase(),
    token,
    accepted: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  // Return invite link — you'd email this to the invitee
  return `https://quickkeep.netlify.app/invite?token=${token}`;
}

// ═══════════════════════════════════════════════════
//  LOCAL STORAGE (Guest / Offline fallback)
// ═══════════════════════════════════════════════════
const LOCAL_KEY = "quickkeep_entries";

function localLoadEntries() {
  return new Promise((r) =>
    chrome.storage.local.get([LOCAL_KEY], (d) => r(d[LOCAL_KEY] || [])),
  );
}

function localSaveEntries(entries) {
  return new Promise((r) =>
    chrome.storage.local.set({ [LOCAL_KEY]: entries }, r),
  );
}

async function localAddEntry({ url, title, note }) {
  const entries = await localLoadEntries();
  if (entries.length >= FREE_LIMIT) {
    throw {
      code: "LIMIT_REACHED",
      upgrade: true,
      message: `Free plan is limited to ${FREE_LIMIT} saves. Upgrade to Pro for unlimited.`,
    };
  }
  const existing = entries.findIndex((e) => e.url === url);
  if (existing > -1) {
    entries[existing].note = note;
    entries[existing].updatedAt = Date.now();
  } else {
    entries.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      url,
      title: title || "Untitled",
      note: note || "",
      savedAt: Date.now(),
    });
  }
  await localSaveEntries(entries);
  return entries;
}

async function localDeleteEntry(id) {
  const entries = await localLoadEntries();
  await localSaveEntries(entries.filter((e) => e.id !== id));
}

async function localClearAll() {
  await localSaveEntries([]);
}
