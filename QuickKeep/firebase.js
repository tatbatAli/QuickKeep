/**
 * QuickKeep — firebase.js
 *
 * Initializes Firebase app, Auth, and Firestore.
 * This file is imported by popup.js inside the extension.
 *
 * HOW TO GET YOUR CONFIG:
 *  1. Go to console.firebase.google.com
 *  2. Open your QuickKeep project
 *  3. Click the gear icon → Project Settings
 *  4. Scroll to "Your apps" → click the web icon </>
 *  5. Copy the firebaseConfig object and paste it below
 */

// ── Paste your Firebase config here ──────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDMN8Bo3GRYMBNl83cV6bowe22qUNGN4NU",
  authDomain: "quickkeep-57a5e.firebaseapp.com",
  projectId: "quickkeep-57a5e",
  storageBucket: "quickkeep-57a5e.firebasestorage.app",
  messagingSenderId: "364223082779",
  appId: "1:364223082779:web:562a207a7bd61379d623be",
};

// ── Firebase SDK imports (from CDN via importScripts or bundled)
// These globals are available because popup.html loads the Firebase
// compat SDK scripts before popup.js.
// See popup.html <script> tags for the SDK URLs.

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

// ── Firestore settings ────────────────────────────────────────
// Enable offline persistence so saved entries work without internet
db.enablePersistence({ synchronizeTabs: false }).catch((err) => {
  if (err.code === "failed-precondition") {
    // Multiple tabs open — persistence only works in one tab at a time
    console.warn(
      "[QuickKeep] Firestore persistence unavailable (multiple tabs)",
    );
  } else if (err.code === "unimplemented") {
    // Browser doesn't support persistence
    console.warn(
      "[QuickKeep] Firestore persistence not supported in this browser",
    );
  }
});
