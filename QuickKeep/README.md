# QuickKeep — Firebase Setup Guide

Everything you need to go from zero to a fully working
syncing, subscription-gated Chrome extension.

---

## Project Structure

```
QuickKeep/                  ← Chrome Extension
├── manifest.json
├── popup.html
├── popup.js                ← Uses Firebase directly
├── firebase.js             ← Firebase init (paste your config here)
├── auth.js                 ← Firebase Auth helpers
├── db-entries.js           ← Firestore operations
├── content.js              ← Double-click / selection save overlay
├── styles.css
├── privacy.html
├── download-firebase-sdk.sh
└── icons/

QuickKeep-Firebase/         ← Firebase backend config
├── firebase.json
├── firestore.rules         ← Security rules
├── firestore.indexes.json  ← Query indexes
└── functions/
    ├── index.js            ← Paddle webhook + team Cloud Functions
    └── package.json
```

---

## Step 1 — Create Firebase Project

1. Go to console.firebase.google.com
2. Click "Add project" → name it "QuickKeep"
3. Disable Google Analytics → Create project

---

## Step 2 — Enable Firebase Auth

1. Sidebar → Authentication → Get started
2. Sign-in method → Email/Password → Enable → Save

---

## Step 3 — Create Firestore Database

1. Sidebar → Firestore Database → Create database
2. Start in production mode
3. Region: europe-west → Done

---

## Step 4 — Deploy Security Rules

In your terminal, from inside the QuickKeep-Firebase/ folder:

```bash
npm install -g firebase-tools
firebase login
firebase init
firebase deploy --only firestore:rules,firestore:indexes
```

---

## Step 5 — Get Your Firebase Config

1. Project Settings (gear icon) → Your apps → click </>
2. Register app as "QuickKeep Extension"
3. Copy the firebaseConfig object
4. Open QuickKeep/firebase.js and paste it in

---

## Step 6 — Download Firebase SDK Files

Chrome extensions cannot load scripts from CDN URLs.
Run this from inside the QuickKeep/ folder:

```bash
chmod +x download-firebase-sdk.sh
./download-firebase-sdk.sh
```

This downloads:
- firebase-app-compat.js
- firebase-auth-compat.js
- firebase-firestore-compat.js

---

## Step 7 — Load the Extension

1. Open chrome://extensions
2. Enable Developer mode
3. Click "Load unpacked" → select the QuickKeep/ folder

---

## Step 8 — Deploy Cloud Functions (for Paddle webhook)

```bash
cd QuickKeep-Firebase/functions && npm install && cd ..
firebase deploy --only functions

firebase functions:config:set \
  paddle.secret="your_webhook_secret" \
  paddle.price_pro_monthly="pri_xxx" \
  paddle.price_pro_yearly="pri_xxx" \
  paddle.price_team_monthly="pri_xxx" \
  paddle.price_team_yearly="pri_xxx"
```

Paddle webhook URL:
https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/paddleWebhook

---

## Free vs Pro vs Team

| Feature              | Free     | Pro       | Team      |
|----------------------|----------|-----------|-----------|
| Save pages           | 100 max  | Unlimited | Unlimited |
| Notes                | Yes      | Yes       | Yes       |
| Sync across devices  | No       | Yes       | Yes       |
| Search               | No       | Yes       | Yes       |
| Export CSV/JSON/MD   | No       | Yes       | Yes       |
| Folders and tags     | No       | Yes       | Yes       |
| Shared collections   | No       | No        | Yes       |
| Comments on pages    | No       | No        | Yes       |
