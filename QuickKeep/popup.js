/**
 * QuickKeep — popup.js
 *
 * Uses Firebase Auth + Firestore directly.
 * No backend server. No API calls to your own server.
 *
 * Three views:
 *   authView    — login / register / guest
 *   mainView    — save, list, search, user menu
 *   upgradeView — pricing cards
 *
 * Data flow:
 *   Guest:          chrome.storage.local (local only)
 *   Logged in Free: Firestore (synced, 100 save limit)
 *   Logged in Pro:  Firestore (synced, unlimited, search, export, folders)
 *   Team:           Firestore (shared collections, comments)
 */

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────
let userProfile = null; // { uid, email, plan, teamId, role } | null
let currentEntries = [];
let isGuest = false;
let unsubEntries = null; // Firestore real-time listener unsubscribe

// ─────────────────────────────────────────────────────────────
//  DOM REFS
// ─────────────────────────────────────────────────────────────
const authView = document.getElementById("authView");
const mainView = document.getElementById("mainView");
const upgradeView = document.getElementById("upgradeView");

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const tabLogin = document.getElementById("tabLogin");
const tabRegister = document.getElementById("tabRegister");

const saveBtn = document.getElementById("saveBtn");
const noteInput = document.getElementById("noteInput");
const listContainer = document.getElementById("listContainer");
const emptyState = document.getElementById("emptyState");
const countBadge = document.getElementById("countBadge");
const clearAllBtn = document.getElementById("clearAllBtn");
const toast = document.getElementById("toast");
const planBadge = document.getElementById("planBadge");
const upgradeBanner = document.getElementById("upgradeBanner");
const userMenuBtn = document.getElementById("userMenuBtn");
const userMenu = document.getElementById("userMenu");
const userEmailEl = document.getElementById("userEmail");
const saveLimitLabel = document.getElementById("saveLimitLabel");
const searchInput = document.getElementById("searchInput");

// ─────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(val) {
  // val can be a Firestore Timestamp, a JS Date, or a unix ms number
  let ts;
  if (!val) return "";
  if (typeof val === "number") ts = val;
  else if (val.toDate) ts = val.toDate().getTime();
  else if (val instanceof Date) ts = val.getTime();
  else ts = Date.now();

  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function showToast(msg, type = "success") {
  toast.textContent = msg;
  toast.className = `qk-toast ${type} show`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("show"), 2200);
}

// ─────────────────────────────────────────────────────────────
//  VIEWS
// ─────────────────────────────────────────────────────────────
function showView(view) {
  [
    authView,
    mainView,
    upgradeView,
    document.getElementById("teamView"),
  ].forEach((v) => v && (v.style.display = "none"));
  view.style.display = "flex";
}

// ─────────────────────────────────────────────────────────────
//  PLAN UI
// ─────────────────────────────────────────────────────────────
function updatePlanUI(plan) {
  const labels = { free: "Free", pro: "Pro ✦", team: "Team ✦" };
  planBadge.textContent = labels[plan] || "Free";
  planBadge.className = `qk-plan-badge ${plan}`;
  upgradeBanner.style.display = plan === "free" ? "" : "none";

  // Show team features if on team plan
  const isTeam = plan === "team";
  document.getElementById("saveTeamBtn").style.display = isTeam ? "" : "none";
  document.getElementById("savesTabs").style.display = isTeam ? "" : "none";
  document.getElementById("listHeader").style.display = isTeam ? "none" : "";

  // teamMenuBtn is added dynamically — safe check
  const teamBtn = document.getElementById("teamMenuBtn");
  if (teamBtn) teamBtn.style.display = isTeam ? "" : "none";
}

// ─────────────────────────────────────────────────────────────
//  AUTH HANDLERS
// ─────────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById("loginBtn");
  btn.textContent = "Signing in…";
  btn.disabled = true;

  try {
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    await loginUser(email, password);
    // onAuthChange listener will fire and call initMain()
  } catch (err) {
    showToast(friendlyAuthError(err.code), "error");
    btn.textContent = "Sign in";
    btn.disabled = false;
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById("registerBtn");
  btn.textContent = "Creating account…";
  btn.disabled = true;

  try {
    const email = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value;
    await registerUser(email, password);
    // onAuthChange listener will fire
  } catch (err) {
    showToast(friendlyAuthError(err.code), "error");
    btn.textContent = "Create free account";
    btn.disabled = false;
  }
}

async function handleLogout() {
  userMenu.style.display = "none";
  if (unsubEntries) {
    unsubEntries();
    unsubEntries = null;
  }
  await logoutUser();
  await chrome.storage.local.remove([
    "qk_user_uid",
    "qk_user_plan",
    "qk_auth_token",
    "qk_auth_expiry",
  ]);
  userProfile = null;
  currentEntries = [];
  isGuest = false;
  showView(authView);
}

async function handleDeleteAccount() {
  userMenu.style.display = "none";

  const confirmed = confirm(
    "Are you sure you want to delete your account?\n\n" +
      "This will permanently delete:\n" +
      "• All your saved pages and notes\n" +
      "• Your account and profile\n" +
      "• Your active subscription (if any)\n\n" +
      "This action cannot be undone.",
  );
  if (!confirmed) return;

  const btn = document.getElementById("deleteAccountBtn");
  btn.textContent = "Deleting…";
  btn.disabled = true;

  try {
    // Call Cloud Function — handles Paddle cancellation + Firestore + Auth deletion
    const deleteAccount = firebase.functions().httpsCallable("deleteAccount");
    await deleteAccount();

    // Clear local storage and listeners
    await chrome.storage.local.clear();
    if (unsubEntries) {
      unsubEntries();
      unsubEntries = null;
    }
    if (unsubTeamEntries) {
      unsubTeamEntries();
      unsubTeamEntries = null;
    }
    if (unsubActivity) {
      unsubActivity();
      unsubActivity = null;
    }

    userProfile = null;
    currentEntries = [];
    isGuest = false;
    showView(authView);
    showToast("Account deleted.");
  } catch (err) {
    console.error("[QuickKeep] Delete account error:", err);
    showToast("Failed to delete account. Please try again.", "error");
    btn.textContent = "Delete Account";
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
//  RENDER LIST
// ─────────────────────────────────────────────────────────────
function renderList(entries) {
  listContainer.querySelectorAll(".qk-entry").forEach((c) => c.remove());

  const n = entries.length;
  countBadge.textContent = n;
  clearAllBtn.classList.toggle("visible", n > 0);
  emptyState.style.display = n === 0 ? "" : "none";

  // Save limit indicator
  const plan = userProfile?.plan || "free";
  if (plan === "free") {
    saveLimitLabel.textContent = `${n} / 20`;
    saveLimitLabel.style.display = "";
  } else {
    saveLimitLabel.style.display = "none";
  }

  [...entries].forEach((entry, i) => {
    const card = document.createElement("div");
    card.className = "qk-entry";
    card.style.animationDelay = `${i * 0.035}s`;

    card.innerHTML = `
      <div class="qk-entry-top">
        <div class="qk-entry-info" title="${escapeHtml(entry.title || "")}">
          <div class="qk-entry-title">${escapeHtml(entry.title || "Untitled")}</div>
          <div class="qk-entry-url">${escapeHtml(shortUrl(entry.url))}</div>
        </div>
        <div class="qk-entry-actions">
          <button class="qk-icon-btn open" title="Open in new tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                 stroke-linecap="round" stroke-linejoin="round" width="11" height="11">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
          <button class="qk-icon-btn delete" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                 stroke-linecap="round" stroke-linejoin="round" width="11" height="11">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      ${entry.note ? `<div class="qk-entry-note">${escapeHtml(entry.note)}</div>` : ""}
      ${
        (entry.tags || []).length
          ? `
        <div class="qk-entry-tags">
          ${entry.tags.map((t) => `<span class="qk-tag">${escapeHtml(t)}</span>`).join("")}
        </div>`
          : ""
      }
      <div class="qk-entry-meta">${formatDate(entry.savedAt)}</div>
    `;

    card.querySelector(".qk-entry-info").addEventListener("click", () => {
      chrome.tabs.create({ url: entry.url });
      if (!isGuest)
        db.collection("entries")
          .doc(entry.id)
          .update({
            lastOpenedAt: firebase.firestore.FieldValue.serverTimestamp(),
          })
          .catch(() => {});
    });
    card.querySelector(".qk-icon-btn.open").addEventListener("click", () => {
      chrome.tabs.create({ url: entry.url });
      if (!isGuest)
        db.collection("entries")
          .doc(entry.id)
          .update({
            lastOpenedAt: firebase.firestore.FieldValue.serverTimestamp(),
          })
          .catch(() => {});
    });
    card
      .querySelector(".qk-icon-btn.delete")
      .addEventListener("click", async () => {
        card.style.transition = "opacity 0.15s, transform 0.15s";
        card.style.opacity = "0";
        card.style.transform = "translateX(8px)";
        await delay(150);
        try {
          if (isGuest) {
            await localDeleteEntry(entry.id);
            currentEntries = currentEntries.filter((e) => e.id !== entry.id);
            renderList(currentEntries);
          } else {
            await deleteEntry(entry.id);
            // Firestore real-time listener will auto-refresh the list
          }
          showToast("Removed");
        } catch {
          showToast("Delete failed", "error");
        }
      });

    listContainer.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────────
//  REAL-TIME FIRESTORE LISTENER
// ─────────────────────────────────────────────────────────────
let unsubTeamEntries = null;
let currentTeamEntries = [];
let activeTab = "personal"; // 'personal' | 'team' | 'notifs'
let lastSeenGroup = parseInt(
  localStorage.getItem("qk_last_seen_group") || "0",
  10,
);

function startEntriesListener(uid) {
  if (unsubEntries) unsubEntries();

  unsubEntries = db
    .collection("entries")
    .where("userId", "==", uid)
    .where("teamId", "==", null)
    .orderBy("savedAt", "desc")
    .onSnapshot(
      (snap) => {
        currentEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (activeTab === "personal") {
          const q = searchInput.value.trim();
          renderList(q ? searchEntries(currentEntries, q) : currentEntries);
        }
      },
      (err) => {
        console.error("[QuickKeep] Firestore listener error:", err);
      },
    );
}

function startTeamEntriesListener(teamId) {
  if (unsubTeamEntries) unsubTeamEntries();

  unsubTeamEntries = db
    .collection("entries")
    .where("teamId", "==", teamId)
    .orderBy("savedAt", "desc")
    .onSnapshot(
      (snap) => {
        currentTeamEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // Only show badge when NOT on the group tab — shows new saves since last visit
        if (activeTab !== "team") {
          const newCount = currentTeamEntries.filter((e) => {
            if (!e.savedAt) return false;
            const ts = e.savedAt.toDate
              ? e.savedAt.toDate().getTime()
              : new Date(e.savedAt).getTime();
            return ts > lastSeenGroup;
          }).length;
          const badge = document.getElementById("teamCountBadge");
          if (newCount > 0) {
            badge.textContent = newCount > 9 ? "9+" : String(newCount);
            badge.style.display = "";
          } else {
            badge.style.display = "none";
          }
        }

        if (activeTab === "team") renderTeamList(currentTeamEntries);
      },
      (err) => {
        console.error("[QuickKeep] Team listener error:", err);
      },
    );
}

// ── Activity Feed ─────────────────────────────────────────────
let unsubActivity = null;

// ─────────────────────────────────────────────────────────────
//  NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
let allActivityEvents = [];
let lastSeenTimestamp = parseInt(
  localStorage.getItem("qk_last_seen_notif") || "0",
  10,
);

function startActivityListener(teamId) {
  if (unsubActivity) unsubActivity();

  unsubActivity = db
    .collection("activity")
    .where("teamId", "==", teamId)
    .orderBy("createdAt", "desc")
    .limit(50)
    .onSnapshot(
      (snap) => {
        allActivityEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        updateNotifTabBadge(allActivityEvents);
        // If notifs tab is open, re-render live
        if (activeTab === "notifs") renderNotifPanel(allActivityEvents);
      },
      (err) => {
        console.error("[QuickKeep] Activity listener error:", err);
      },
    );
}

function updateNotifTabBadge(events) {
  const badge = document.getElementById("notifTabBadge");
  if (!badge) return;
  // Only show badge if user is NOT currently on notifs tab
  if (activeTab === "notifs") {
    badge.style.display = "none";
    return;
  }
  const unread = events.filter((ev) => {
    if (!ev.createdAt) return false;
    const ts = ev.createdAt.toDate
      ? ev.createdAt.toDate().getTime()
      : new Date(ev.createdAt).getTime();
    return ts > lastSeenTimestamp;
  }).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? "9+" : String(unread);
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}

// Keep legacy names so nothing else breaks
function renderActivityBar() {}
function renderNotifBadge(events) {
  updateNotifTabBadge(events);
}

function renderNotifPanel(events) {
  const list = document.getElementById("notifList");
  if (!list) {
    console.error("[QK] notifList not found");
    return;
  }

  const reactionEmoji = {
    mustsave: "🔖",
    meh: "😑",
    mindblown: "🤯",
    watching: "👀",
  };
  const reactionLabels = {
    mustsave: "Must Save",
    meh: "Meh",
    mindblown: "Mind Blown",
    watching: "Watching",
  };

  if (!events || !events.length) {
    list.innerHTML = `
      <div class="qk-notif-empty">
        <div class="qk-notif-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round" width="26" height="26">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </div>
        <div class="qk-notif-empty-title">All quiet here</div>
        <div class="qk-notif-empty-sub">When your friends save pages or react, it'll show up here.</div>
      </div>`;
    return;
  }

  list.innerHTML = events
    .map((ev, i) => {
      const name = ev.actorEmail ? ev.actorEmail.split("@")[0] : "Someone";
      const time = ev.createdAt
        ? timeAgo(
            ev.createdAt.toDate
              ? ev.createdAt.toDate()
              : new Date(ev.createdAt),
          )
        : "";
      const ts = ev.createdAt
        ? ev.createdAt.toDate
          ? ev.createdAt.toDate().getTime()
          : new Date(ev.createdAt).getTime()
        : 0;
      const isUnread = ts > lastSeenTimestamp;

      let iconHtml = "",
        textHtml = "",
        pageHtml = "";

      if (ev.type === "save") {
        iconHtml = `<div class="qk-notif-icon save">
        <svg viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" width="13" height="13">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg></div>`;
        textHtml = `<strong>${escapeHtml(name)}</strong> saved a page to the group`;
        pageHtml = `<div class="qk-notif-page">${escapeHtml(ev.title || ev.url || "a page")}</div>`;
      } else if (ev.type === "reaction") {
        const emoji = reactionEmoji[ev.reaction] || "👍";
        const label = reactionLabels[ev.reaction] || "";
        iconHtml = `<div class="qk-notif-icon react"><span style="font-size:14px;line-height:1">${emoji}</span></div>`;
        textHtml = `<strong>${escapeHtml(name)}</strong> reacted ${emoji}${label ? ` (${label})` : ""} to a save`;
        pageHtml = ev.title
          ? `<div class="qk-notif-page">${escapeHtml(ev.title)}</div>`
          : "";
      } else if (ev.type === "remove") {
        iconHtml = `<div class="qk-notif-icon remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fb7185" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" width="13" height="13">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg></div>`;
        textHtml = `<strong>${escapeHtml(name)}</strong> removed a save from the group`;
        pageHtml = ev.title
          ? `<div class="qk-notif-page">${escapeHtml(ev.title)}</div>`
          : "";
      } else {
        return "";
      }

      return `<div class="qk-notif-item${isUnread ? " unread" : ""}" style="animation-delay:${i * 0.04}s">
      ${iconHtml}
      <div class="qk-notif-body">
        <div class="qk-notif-text">${textHtml}</div>
        ${pageHtml}
      </div>
      <div class="qk-notif-time">${time}</div>
      ${isUnread ? '<div class="qk-notif-dot"></div>' : ""}
    </div>`;
    })
    .join("");
}

// ── legacy alias ───────────────────────────────────────────────
function renderActivityFeed(events) {
  updateNotifTabBadge(events);
}

// ── Time ago helper ───────────────────────────────────────────
function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderTeamList(entries) {
  const container = document.getElementById("teamListContainer");
  const empty = document.getElementById("teamEmptyState");

  if (!entries.length) {
    container.innerHTML = "";
    container.appendChild(empty);
    empty.style.display = "";
    return;
  }

  const isOwner = userProfile && userProfile.role === "owner";
  const myUid = window._qkUserUid || "";
  const myEmail = window._qkUserEmail || "";

  // Reaction definitions — SVG icons with colors
  const REACTIONS = [
    {
      key: "mustsave",
      title: "Must Save!",
      color: "#f59e0b",
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`,
    },
    {
      key: "meh",
      title: "Meh 🥱",
      color: "#94a3b8",
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M8 12h8"/><circle cx="12" cy="12" r="10"/><path d="M8 9h.01M16 9h.01"/></svg>`,
    },
    {
      key: "mindblown",
      title: "Mind Blown 🤯",
      color: "#f97316",
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>`,
    },
    {
      key: "watching",
      title: "Watching 👀",
      color: "#38bdf8",
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    },
  ];

  container.innerHTML = entries
    .map((e) => {
      // Extract "saved by" name from email
      const savedByEmail = e.savedByEmail || "";
      const savedByName = savedByEmail ? savedByEmail.split("@")[0] : "";

      // Build reactions row
      const reactions = e.reactions || {
        lightning: [],
        diamond: [],
        rocket: [],
        brain: [],
      };
      const reactionsHtml = REACTIONS.map((r) => {
        const uids = reactions[r.key] || [];
        const count = uids.length;
        const reacted = uids.includes(myUid);
        return `<button class="qk-reaction-btn ${reacted ? "reacted" : ""}"
                data-entry="${e.id}" data-key="${r.key}"
                data-color="${r.color}" title="${r.title}"
                style="${reacted ? `--r-color:${r.color}` : ""}">
        ${r.svg}
        ${count > 0 ? `<span class="qk-reaction-count">${count}</span>` : ""}
      </button>`;
      }).join("");

      return `
    <div class="qk-entry" data-id="${e.id}">
      <div class="qk-entry-top">
        <div class="qk-entry-info" style="flex:1;min-width:0;">
          <div class="qk-entry-title" style="cursor:default;">
            ${escapeHtml(e.title || shortUrl(e.url))}
          </div>
          <div class="qk-entry-meta">
            <span class="qk-entry-url">${escapeHtml(shortUrl(e.url))}</span>
            ${savedByName ? `<span class="qk-saved-by">by ${escapeHtml(savedByName)}</span>` : ""}
          </div>
        </div>
        <div class="qk-entry-actions">
          <span class="qk-entry-date" style="font-size:10px;color:var(--qk-muted);align-self:center;">${formatDate(e.savedAt)}</span>
          <button class="qk-icon-btn open" data-url="${escapeHtml(e.url)}" title="Open page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" width="12" height="12">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
          ${
            isOwner
              ? `<button class="qk-icon-btn delete qk-delete-team-btn" data-id="${e.id}" title="Remove from team">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                 stroke-linecap="round" stroke-linejoin="round" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>`
              : ""
          }
        </div>
      </div>
      ${e.note ? `<div class="qk-entry-note">${escapeHtml(e.note)}</div>` : ""}
      <div class="qk-reactions-row">${reactionsHtml}</div>
    </div>`;
    })
    .join("");

  // Open button handlers
  container.querySelectorAll(".qk-icon-btn.open").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: btn.dataset.url });
      const entryId = btn.closest(".qk-entry")?.dataset.id;
      if (entryId)
        db.collection("entries")
          .doc(entryId)
          .update({
            lastOpenedAt: firebase.firestore.FieldValue.serverTimestamp(),
          })
          .catch(() => {});
    });
  });

  // Delete button handlers (owner only)
  if (isOwner) {
    container.querySelectorAll(".qk-delete-team-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          await db.collection("entries").doc(id).delete();
          showToast("Removed from team");
        } catch (err) {
          console.error("[QuickKeep] Team delete error:", err);
          showToast("Failed to remove", "error");
        }
      });
    });
  }

  // Reaction button handlers
  container.querySelectorAll(".qk-reaction-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entryId = btn.dataset.entry;
      const key = btn.dataset.key;
      const color = btn.dataset.color;
      const reacted = btn.classList.contains("reacted");

      // Bounce animation
      btn.classList.add("qk-reaction-bounce");
      setTimeout(() => btn.classList.remove("qk-reaction-bounce"), 400);

      try {
        const allKeys = ["mustsave", "meh", "mindblown", "watching"];
        const batch = {};

        if (reacted) {
          // Already reacted — remove it (toggle off)
          batch[`reactions.${key}`] =
            firebase.firestore.FieldValue.arrayRemove(myUid);
        } else {
          // Remove from all other keys first, then add to this one
          allKeys.forEach((k) => {
            batch[`reactions.${k}`] =
              firebase.firestore.FieldValue.arrayRemove(myUid);
          });
          batch[`reactions.${key}`] =
            firebase.firestore.FieldValue.arrayUnion(myUid);
        }

        await db.collection("entries").doc(entryId).update(batch);

        // Log reaction activity (only when adding, not removing)
        if (!reacted) {
          db.collection("activity")
            .add({
              teamId: userProfile.teamId,
              type: "reaction",
              actorEmail: window._qkUserEmail || "",
              actorUid: myUid,
              reaction: key,
              title:
                document
                  .querySelector(
                    `.qk-entry[data-id="${entryId}"] .qk-entry-title`,
                  )
                  ?.textContent?.trim() || "a save",
              entryId,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error("[QuickKeep] Reaction error:", err);
        showToast("Failed to react", "error");
      }
    });
  });
}

// ── Tab switching ─────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
//  TAB SWITCHING
// ─────────────────────────────────────────────────────────────
function setActiveTab(tab) {
  activeTab = tab;

  // Update tab button states
  document
    .getElementById("tabMySaves")
    .classList.toggle("active", tab === "personal");
  document
    .getElementById("tabTeamSaves")
    .classList.toggle("active", tab === "team");
  document
    .getElementById("tabNotifs")
    .classList.toggle("active", tab === "notifs");

  // Show/hide containers
  document.getElementById("listContainer").style.display =
    tab === "personal" ? "" : "none";
  document.getElementById("teamListContainer").style.display =
    tab === "team" ? "" : "none";
  document.getElementById("notifContainer").style.display =
    tab === "notifs" ? "" : "none";

  // Clear badge when user visits the tab
  if (tab === "team") {
    lastSeenGroup = Date.now();
    localStorage.setItem("qk_last_seen_group", String(lastSeenGroup));
    document.getElementById("teamCountBadge").style.display = "none";
  }
  if (tab === "notifs") {
    // Mark all as read
    lastSeenTimestamp = Date.now();
    localStorage.setItem("qk_last_seen_notif", String(lastSeenTimestamp));
    document.getElementById("notifTabBadge").style.display = "none";
    renderNotifPanel(allActivityEvents);
  }

  if (tab === "personal") {
    const q = searchInput.value.trim();
    renderList(q ? searchEntries(currentEntries, q) : currentEntries);
  }
  if (tab === "team") {
    renderTeamList(currentTeamEntries);
  }
}

document
  .getElementById("tabMySaves")
  .addEventListener("click", () => setActiveTab("personal"));
document
  .getElementById("tabTeamSaves")
  .addEventListener("click", () => setActiveTab("team"));
document
  .getElementById("tabNotifs")
  .addEventListener("click", () => setActiveTab("notifs"));

// ─────────────────────────────────────────────────────────────
//  SAVE
// ─────────────────────────────────────────────────────────────
async function saveCurrentPage() {
  saveBtn.disabled = true;
  saveBtn.innerHTML = "<span>Saving…</span>";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (
      !tab?.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://")
    ) {
      showToast("Cannot save this page type", "error");
      return;
    }

    const note = noteInput.value.trim();

    if (isGuest) {
      await localAddEntry({
        url: tab.url,
        title: tab.title || "Untitled",
        note,
      });
      currentEntries = await localLoadEntries();
      renderList(currentEntries);
    } else {
      const plan = userProfile?.plan || "free";
      await saveEntry(userProfile.uid, plan, {
        url: tab.url,
        title: tab.title || "Untitled",
        note,
      });
      // Firestore listener auto-refreshes the list
    }

    noteInput.value = "";
    showToast("Page saved!");
  } catch (err) {
    if (err.upgrade) {
      showToast(err.message, "error");
      setTimeout(() => showView(upgradeView), 800);
    } else {
      console.error("[QuickKeep] Save error:", err);
      showToast("Save failed", "error");
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" width="13" height="13">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Save This Page`;
  }
}

// ─────────────────────────────────────────────────────────────
//  SEARCH (Pro — client-side filter on already-fetched entries)
// ─────────────────────────────────────────────────────────────
let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);

  if (isGuest || userProfile?.plan === "free") {
    showToast("Search is a Pro feature", "error");
    searchInput.value = "";
    setTimeout(() => showView(upgradeView), 500);
    return;
  }

  searchTimer = setTimeout(() => {
    const q = searchInput.value.trim();
    renderList(q ? searchEntries(currentEntries, q) : currentEntries);
  }, 250);
});

// ─────────────────────────────────────────────────────────────
//  EXPORT (Pro)
// ─────────────────────────────────────────────────────────────
async function handleExport(format) {
  userMenu.style.display = "none";

  if (isGuest || userProfile?.plan === "free") {
    showToast("Export is a Pro feature", "error");
    setTimeout(() => showView(upgradeView), 500);
    return;
  }

  try {
    let content, filename, mime;

    if (format === "csv") {
      content = exportAsCSV(currentEntries);
      filename = "quickkeep-export.csv";
      mime = "text/csv";
    } else if (format === "markdown") {
      content = exportAsMarkdown(currentEntries);
      filename = "quickkeep-export.md";
      mime = "text/markdown";
    } else {
      content = exportAsJSON(currentEntries);
      filename = "quickkeep-export.json";
      mime = "application/json";
    }

    downloadFile(content, filename, mime);
    showToast("Export downloaded!");
  } catch (err) {
    console.error("[QuickKeep] Export error:", err);
    showToast("Export failed", "error");
  }
}

// ─────────────────────────────────────────────────────────────
//  CLEAR ALL
// ─────────────────────────────────────────────────────────────
clearAllBtn.addEventListener("click", async () => {
  if (!confirm("Delete all saved pages? This cannot be undone.")) return;
  try {
    if (isGuest) {
      await localClearAll();
      currentEntries = [];
      renderList([]);
    } else {
      await clearAllEntries(userProfile.uid);
      // Listener auto-refreshes
    }
    showToast("All entries cleared");
  } catch {
    showToast("Clear failed", "error");
  }
});

// ─────────────────────────────────────────────────────────────
//  INIT MAIN VIEW
// ─────────────────────────────────────────────────────────────
async function initMain(user) {
  showView(mainView);

  if (user && !isGuest) {
    // Logged-in user — load profile from Firestore
    userProfile = await getUserProfile(user.uid);

    if (!userProfile) {
      await db.collection("users").doc(user.uid).set({
        email: user.email,
        plan: "free",
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      userProfile = { uid: user.uid, email: user.email, plan: "free" };

      // Check if they paid before creating their account
      const pendingSnap = await db
        .collection("pending_upgrades")
        .doc(user.email)
        .get();
      if (pendingSnap.exists) {
        const { plan, paddleSubId } = pendingSnap.data();
        await db
          .collection("users")
          .doc(user.uid)
          .update({ plan, paddleSubId });
        await pendingSnap.ref.delete();
        userProfile.plan = plan;
      }
    }

    // Store auth info for background service worker
    const token = await user.getIdToken();
    await chrome.storage.local.set({
      qk_user_uid: user.uid,
      qk_user_plan: userProfile.plan || "free",
      qk_auth_token: token,
      qk_auth_expiry: Date.now() + 55 * 60 * 1000, // 55 min (token expires in 60)
    });

    userEmailEl.textContent = userProfile.email || user.email;
    window._qkUserEmail = userProfile.email || user.email;
    window._qkUserUid = user.uid;
    updatePlanUI(userProfile.plan || "free");
    startEntriesListener(user.uid);

    // Start team listener if user is on team plan and has a team
    if (userProfile.plan === "team" && userProfile.teamId) {
      startTeamEntriesListener(userProfile.teamId);
      startActivityListener(userProfile.teamId);
    }
  } else {
    // Guest mode
    isGuest = true;
    await chrome.storage.local.remove([
      "qk_user_uid",
      "qk_user_plan",
      "qk_auth_token",
      "qk_auth_expiry",
    ]);
    userEmailEl.textContent = "Guest";
    updatePlanUI("free");

    const local = await localLoadEntries();
    currentEntries = local;
    renderList(local);
  }
}

// ─────────────────────────────────────────────────────────────
//  PENDING SAVE LISTENER
//  When content script saves a page, it goes to chrome.storage
//  as a pending save. The popup picks it up here and saves to
//  Firebase (or local storage for guests).
// ─────────────────────────────────────────────────────────────
async function processPendingSave() {
  const result = await new Promise((resolve) =>
    chrome.storage.local.get(["qk_pending_save"], resolve),
  );

  const pending = result.qk_pending_save;
  if (!pending) return;

  // Clear it immediately to avoid processing twice
  await new Promise((resolve) =>
    chrome.storage.local.remove(["qk_pending_save"], resolve),
  );

  const { url, title, note } = pending;

  try {
    if (isGuest) {
      await localAddEntry({ url, title, note });
      currentEntries = await localLoadEntries();
      renderList(currentEntries);
    } else if (userProfile) {
      await saveEntry(userProfile.uid, userProfile.plan || "free", {
        url,
        title,
        note,
      });
      // Firestore listener auto-refreshes the list
    }
  } catch (err) {
    console.error("[QuickKeep] Pending save error:", err);
  }
}

// Listen for storage changes (content script just saved something)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.qk_pending_save) {
    processPendingSave();
  }
});

//  This is the main entry point — Firebase tells us when the
//  user is logged in or out, then we show the right view.
// ─────────────────────────────────────────────────────────────
onAuthChange(async (firebaseUser) => {
  if (firebaseUser && !isGuest) {
    // User is logged in
    await initMain(firebaseUser);
  } else if (!isGuest) {
    // Not logged in and not guest — show auth screen
    showView(authView);
  }
});

// ─────────────────────────────────────────────────────────────
//  EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

// Auth tab switching
tabLogin.addEventListener("click", () => {
  tabLogin.classList.add("active");
  tabRegister.classList.remove("active");
  loginForm.style.display = "";
  registerForm.style.display = "none";
});
tabRegister.addEventListener("click", () => {
  tabRegister.classList.add("active");
  tabLogin.classList.remove("active");
  registerForm.style.display = "";
  loginForm.style.display = "none";
});

// Auth forms
loginForm.addEventListener("submit", handleLogin);
registerForm.addEventListener("submit", handleRegister);

// Guest / skip
document.getElementById("skipAuthBtn").addEventListener("click", async () => {
  isGuest = true;
  await initMain(null);
});

// Save button
saveBtn.addEventListener("click", saveCurrentPage);
noteInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") saveCurrentPage();
});

// Save to Team button
document.getElementById("saveTeamBtn").addEventListener("click", async () => {
  if (!userProfile?.teamId) {
    showToast("Create a team first", "error");
    return;
  }

  const btn = document.getElementById("saveTeamBtn");
  btn.textContent = "Saving…";
  btn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const note = noteInput.value.trim();

    await saveEntry(userProfile.uid, userProfile.plan, {
      url: tab.url,
      title: tab.title,
      note,
      teamId: userProfile.teamId,
    });

    // Log activity event
    db.collection("activity")
      .add({
        teamId: userProfile.teamId,
        type: "save",
        actorEmail: window._qkUserEmail || "",
        actorUid: userProfile.uid,
        title: tab.title || shortUrl(tab.url),
        url: tab.url,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      })
      .catch(() => {});

    noteInput.value = "";
    showToast("Saved to team!");

    // Switch to team tab to show the save
    document.getElementById("tabTeamSaves").click();
  } catch (err) {
    console.error("[QuickKeep] Save to team error:", err);
    showToast("Failed to save to team", "error");
  } finally {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
      stroke-linecap="round" stroke-linejoin="round" width="13" height="13">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg> Team`;
    btn.disabled = false;
  }
});

// User menu
userMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  userMenu.style.display = userMenu.style.display === "none" ? "" : "none";
});
document.addEventListener("click", () => (userMenu.style.display = "none"));

// Menu actions
document.getElementById("logoutBtn").addEventListener("click", handleLogout);
document
  .getElementById("deleteAccountBtn")
  .addEventListener("click", handleDeleteAccount);
document
  .getElementById("exportCsvBtn")
  .addEventListener("click", () => handleExport("csv"));
document
  .getElementById("exportMdBtn")
  .addEventListener("click", () => handleExport("markdown"));

// Upgrade
document
  .getElementById("upgradeBannerBtn")
  .addEventListener("click", () => showView(upgradeView));
document
  .getElementById("backFromUpgrade")
  .addEventListener("click", () => showView(mainView));

// ── Upgrade view billing toggle ───────────────────────────────
const popupToggle = document.getElementById("popupBillingToggle");
const popupLabelMonthly = document.getElementById("popupLabelMonthly");
const popupLabelYearly = document.getElementById("popupLabelYearly");
let popupIsYearly = false;

popupToggle.addEventListener("click", () => {
  popupIsYearly = !popupIsYearly;
  popupToggle.classList.toggle("active", popupIsYearly);

  popupLabelMonthly.style.color = popupIsYearly
    ? "var(--qk-muted)"
    : "var(--qk-text)";
  popupLabelYearly.style.color = popupIsYearly
    ? "var(--qk-text)"
    : "var(--qk-muted)";

  document
    .querySelectorAll(".popup-price-monthly")
    .forEach((el) => (el.style.display = popupIsYearly ? "none" : ""));
  document
    .querySelectorAll(".popup-price-yearly")
    .forEach((el) => (el.style.display = popupIsYearly ? "" : "none"));
  document
    .querySelectorAll(".popup-alt-monthly")
    .forEach((el) => (el.style.display = popupIsYearly ? "none" : ""));
  document
    .querySelectorAll(".popup-alt-yearly")
    .forEach((el) => (el.style.display = popupIsYearly ? "" : "none"));
  document
    .querySelectorAll(".popup-btn-monthly")
    .forEach((el) => (el.style.display = popupIsYearly ? "none" : ""));
  document
    .querySelectorAll(".popup-btn-yearly")
    .forEach((el) => (el.style.display = popupIsYearly ? "" : "none"));
});

// Open checkout in new tab via Netlify page
document.querySelectorAll(".popup-pro-btn, .popup-team-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const priceId = popupIsYearly ? btn.dataset.yearly : btn.dataset.monthly;
    chrome.tabs.create({
      url: `https://usequickkeep.netlify.app/?checkout=${priceId}`,
    });
  });
});

// ─────────────────────────────────────────────────────────────
//  TEAM VIEW
// ─────────────────────────────────────────────────────────────
const teamView = document.getElementById("teamView");
let unsubShared = null;

document
  .getElementById("backFromTeam")
  .addEventListener("click", () => showView(mainView));

// ── Open team view from user menu ─────────────────────────────
async function openTeamView() {
  userMenu.style.display = "none";
  showView(teamView);

  const createSection = document.getElementById("teamCreateSection");
  const manageSection = document.getElementById("teamManageSection");

  if (!userProfile?.teamId) {
    createSection.style.display = "";
    manageSection.style.display = "none";
    document.getElementById("teamViewTitle").textContent = "Create Team";
  } else {
    createSection.style.display = "none";
    manageSection.style.display = "";
    document.getElementById("teamViewTitle").textContent = "Team";
    await loadTeamData(userProfile.teamId);
  }
}

// ── Load team data ────────────────────────────────────────────
async function loadTeamData(teamId) {
  try {
    const teamDoc = await db.collection("teams").doc(teamId).get();
    if (!teamDoc.exists) return;

    const team = teamDoc.data();
    const isOwner = team.ownerId === userProfile.uid;

    // Update role from team document
    userProfile.role = isOwner ? "owner" : "member";

    document.getElementById("teamNameDisplay").textContent = team.name;
    document.getElementById("teamRoleDisplay").textContent = isOwner
      ? "Owner"
      : "Member";

    // Show invite section ONLY for owner
    document.getElementById("inviteSection").style.display = isOwner
      ? ""
      : "none";
    document.getElementById("inviteLinkWrap").style.display = "none";

    // Display members from the team doc directly (no extra user doc fetches needed)
    const membersList = document.getElementById("membersList");
    const members =
      team.members ||
      team.memberIds.map((uid) => ({
        uid,
        email: uid,
        role: uid === team.ownerId ? "owner" : "member",
      }));

    membersList.innerHTML = members.length
      ? members
          .map(
            (m) => `
          <div class="qk-member-row">
            <span class="qk-member-email">${escapeHtml(m.email)}</span>
            <span class="qk-member-role">${m.role === "owner" ? "Owner" : "Member"}</span>
          </div>
        `,
          )
          .join("")
      : '<div style="font-size:11px;color:var(--qk-muted);padding:4px 0">No members yet.</div>';
  } catch (err) {
    console.error("[QuickKeep] Team load error:", err);
    showToast("Failed to load team", "error");
  }
}

// ── Create team ───────────────────────────────────────────────
document.getElementById("createTeamBtn").addEventListener("click", async () => {
  const nameInput = document.getElementById("teamNameInput");
  const teamName = nameInput.value.trim();
  if (!teamName) {
    showToast("Enter a team name", "error");
    return;
  }

  const btn = document.getElementById("createTeamBtn");
  btn.textContent = "Creating…";
  btn.disabled = true;

  try {
    // Create team document — store emails directly for easy access
    const teamRef = await db.collection("teams").add({
      name: teamName,
      ownerId: userProfile.uid,
      memberIds: [userProfile.uid],
      members: [
        { uid: userProfile.uid, email: userProfile.email, role: "owner" },
      ],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Update user profile
    await db.collection("users").doc(userProfile.uid).update({
      teamId: teamRef.id,
      role: "owner",
    });

    userProfile.teamId = teamRef.id;
    userProfile.role = "owner";

    showToast("Team created!");
    nameInput.value = "";
    await openTeamView();
  } catch (err) {
    console.error("[QuickKeep] Create team error:", err);
    showToast("Failed to create team", "error");
  } finally {
    btn.textContent = "Create Team";
    btn.disabled = false;
  }
});

// ── Send invite ───────────────────────────────────────────────
document.getElementById("sendInviteBtn").addEventListener("click", async () => {
  const emailInput = document.getElementById("inviteEmailInput");
  const inviteEmail = emailInput.value.trim().toLowerCase();
  if (!inviteEmail) {
    showToast("Enter an email address", "error");
    return;
  }

  const btn = document.getElementById("sendInviteBtn");
  btn.textContent = "Generating…";
  btn.disabled = true;

  try {
    // Check current member count — cap at 5 (owner + 4 members)
    const teamDoc = await db.collection("teams").doc(userProfile.teamId).get();
    const memberCount = teamDoc.data()?.memberIds?.length || 1;
    if (memberCount >= 5) {
      showToast("Team is full — max 5 members", "error");
      btn.textContent = "Send Invite";
      btn.disabled = false;
      return;
    }

    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);

    await db.collection("invites").add({
      teamId: userProfile.teamId,
      email: inviteEmail,
      token,
      accepted: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Show the invite link
    const inviteLink = `https://usequickkeep.netlify.app/?invite=${token}`;
    document.getElementById("inviteLinkWrap").style.display = "";
    document.getElementById("inviteLinkInput").value = inviteLink;

    showToast("Invite link generated!");
    emailInput.value = "";
  } catch (err) {
    console.error("[QuickKeep] Invite error:", err);
    showToast("Failed to create invite", "error");
  } finally {
    btn.textContent = "Send Invite";
    btn.disabled = false;
  }
});

// ── Copy invite link ──────────────────────────────────────────
document.getElementById("copyInviteLinkBtn").addEventListener("click", () => {
  const linkInput = document.getElementById("inviteLinkInput");
  navigator.clipboard.writeText(linkInput.value).then(() => {
    showToast("Link copied!");
  });
});

// toggleSharedBtn removed — shared saves now shown in Team tab on main view

// ── Team button in user menu ──────────────────────────────────
document.getElementById("teamMenuBtn").addEventListener("click", () => {
  openTeamView();
});
