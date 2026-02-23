#!/bin/bash
# QuickKeep — download-firebase-sdk.sh
#
# Chrome extensions cannot load scripts from external CDNs.
# This script downloads the Firebase SDK files locally so
# the extension can load them from the extension folder itself.
#
# Run this once from inside the QuickKeep/ extension folder:
#   chmod +x download-firebase-sdk.sh
#   ./download-firebase-sdk.sh

FIREBASE_VERSION="10.7.1"
BASE_URL="https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}"

echo "Downloading Firebase SDK v${FIREBASE_VERSION}..."

curl -o firebase-app-compat.js       "${BASE_URL}/firebase-app-compat.js"
curl -o firebase-auth-compat.js      "${BASE_URL}/firebase-auth-compat.js"
curl -o firebase-firestore-compat.js "${BASE_URL}/firebase-firestore-compat.js"

echo ""
echo "Done! Three files downloaded:"
echo "  firebase-app-compat.js"
echo "  firebase-auth-compat.js"
echo "  firebase-firestore-compat.js"
echo ""
echo "Now open chrome://extensions, reload QuickKeep, and it should work."
