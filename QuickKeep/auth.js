/**
 * QuickKeep — auth.js
 *
 * All authentication logic using Firebase Auth.
 * Imported by popup.js.
 *
 * Functions exported:
 *   registerUser(email, password)
 *   loginUser(email, password)
 *   logoutUser()
 *   getCurrentUser()         → Firebase User object | null
 *   onAuthStateChanged(cb)   → listener unsubscribe function
 *   getUserProfile(uid)      → Firestore user document data
 */

// ── Register a new user ───────────────────────────────────────
async function registerUser(email, password) {
  // Create Firebase Auth account
  const credential = await auth.createUserWithEmailAndPassword(email, password);
  const user       = credential.user;

  // Create Firestore user profile document
  await db.collection('users').doc(user.uid).set({
    email:       email.toLowerCase(),
    plan:        'free',
    paddleSubId: null,
    teamId:      null,
    role:        'member',
    createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
  });

  return user;
}

// ── Login ─────────────────────────────────────────────────────
async function loginUser(email, password) {
  const credential = await auth.signInWithEmailAndPassword(email, password);
  return credential.user;
}

// ── Logout ────────────────────────────────────────────────────
async function logoutUser() {
  await auth.signOut();
}

// ── Get current logged-in user ────────────────────────────────
function getCurrentUser() {
  return auth.currentUser;
}

// ── Listen for auth state changes ─────────────────────────────
// Returns an unsubscribe function — call it to stop listening.
function onAuthChange(callback) {
  return auth.onAuthStateChanged(callback);
}

// ── Get user profile from Firestore ──────────────────────────
// Returns { email, plan, teamId, role } or null
async function getUserProfile(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? { uid, ...doc.data() } : null;
}

// ── Map Firebase Auth error codes to friendly messages ────────
function friendlyAuthError(code) {
  const map = {
    'auth/email-already-in-use':    'An account with this email already exists.',
    'auth/invalid-email':           'Please enter a valid email address.',
    'auth/weak-password':           'Password must be at least 6 characters.',
    'auth/user-not-found':          'No account found with this email.',
    'auth/wrong-password':          'Incorrect password. Please try again.',
    'auth/too-many-requests':       'Too many attempts. Please wait a moment.',
    'auth/network-request-failed':  'Network error. Check your connection.',
    'auth/user-disabled':           'This account has been disabled.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}
