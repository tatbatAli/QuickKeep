/**
 * QuickKeep — Cloud Functions (functions/index.js)
 *
 * Contains ONE Cloud Function:
 *   paddleWebhook — receives Paddle payment events and
 *                   updates the user's plan in Firestore.
 *
 * Deploy with: firebase deploy --only functions
 *
 * SETUP:
 *   1. cd functions && npm install
 *   2. Set your Paddle webhook secret:
 *      firebase functions:config:set paddle.secret="YOUR_WEBHOOK_SECRET"
 *   3. In your Paddle dashboard, set the webhook URL to:
 *      https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/paddleWebhook
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ── Map Paddle Price IDs to QuickKeep plans ───────────────────
const PRICE_TO_PLAN = () => ({
  [process.env.PADDLE_PRICE_PRO_MONTHLY]: "pro",
  [process.env.PADDLE_PRICE_PRO_YEARLY]: "pro",
  [process.env.PADDLE_PRICE_TEAM_MONTHLY]: "team",
  [process.env.PADDLE_PRICE_TEAM_YEARLY]: "team",
});

// ── Verify Paddle webhook signature ──────────────────────────
function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(";").map((p) => p.split("=")),
  );
  const ts = parts.ts;
  const hash = parts.h1;
  const signed = `${ts}:${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signed)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

// ── Cloud Function: paddleWebhook ─────────────────────────────
exports.paddleWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const secret = process.env.PADDLE_SECRET;
  const signature = req.headers["paddle-signature"];
  const rawBody = JSON.stringify(req.body);

  // Verify the request is genuinely from Paddle
  if (!verifySignature(rawBody, signature, secret)) {
    functions.logger.warn("[Paddle] Invalid signature — request rejected");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { event_type, data } = req.body;
  const email = data?.customer?.email?.toLowerCase();
  const subId = data?.id;
  const status = data?.status;
  const priceId = data?.items?.[0]?.price?.id;
  const plan = PRICE_TO_PLAN()[priceId] || "pro";

  if (!email) {
    return res.status(400).json({ error: "No email in payload" });
  }

  try {
    // Find the user by email
    const usersRef = db.collection("users");
    const snapshot = await usersRef.where("email", "==", email).limit(1).get();

    if (snapshot.empty) {
      // User paid but hasn't created their extension account yet.
      // Store the pending upgrade — will be applied when they sign up.
      functions.logger.warn(
        `[Paddle] No user found for email: ${email} — storing pending upgrade`,
      );
      await db.collection("pending_upgrades").doc(email).set({
        email,
        plan,
        paddleSubId: subId,
        event_type,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ received: true, warning: "Pending upgrade stored" });
    }

    const userDoc = snapshot.docs[0];

    switch (event_type) {
      // ── Payment successful → upgrade plan ──────────────────
      case "subscription.created":
      case "subscription.activated":
        if (status === "active") {
          await userDoc.ref.update({ plan, paddleSubId: subId });
          functions.logger.info(`[Paddle] Upgraded ${email} to ${plan}`);
        }
        break;

      // ── Plan changed ───────────────────────────────────────
      case "subscription.updated":
        const newPlan = status === "active" ? plan : "free";
        await userDoc.ref.update({ plan: newPlan });
        functions.logger.info(`[Paddle] Updated ${email} to ${newPlan}`);
        break;

      // ── Cancelled → downgrade to free ─────────────────────
      case "subscription.cancelled":
        await userDoc.ref.update({ plan: "free", paddleSubId: null });
        functions.logger.info(`[Paddle] Downgraded ${email} to free`);
        break;

      // ── Payment failed — you could trigger a dunning email here
      case "subscription.payment_failed":
        functions.logger.warn(`[Paddle] Payment failed for ${email}`);
        break;

      default:
        functions.logger.info(`[Paddle] Unhandled event: ${event_type}`);
    }

    return res.json({ received: true });
  } catch (err) {
    functions.logger.error("[Paddle] Webhook error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ── Cloud Function: createTeam ────────────────────────────────
// Creates a team and sets the calling user as owner.
// Called from the extension when a user clicks "Create Team".
exports.createTeam = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in.",
    );

  const { teamName } = data;
  if (!teamName)
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Team name required.",
    );

  const uid = context.auth.uid;

  // Verify user is on team plan
  const userDoc = await db.collection("users").doc(uid).get();
  if (!["team"].includes(userDoc.data()?.plan)) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Team plan required.",
    );
  }

  // Create team document
  const teamRef = await db.collection("teams").add({
    name: teamName,
    ownerId: uid,
    memberIds: [uid],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Update user's teamId
  await db
    .collection("users")
    .doc(uid)
    .update({ teamId: teamRef.id, role: "owner" });

  return { teamId: teamRef.id };
});

// ── Cloud Function: acceptInvite ──────────────────────────────
// Adds the calling user to a team via invite token.
exports.acceptInvite = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in.",
    );

  const { token } = data;
  if (!token)
    throw new functions.https.HttpsError("invalid-argument", "Token required.");

  const inviteSnap = await db
    .collection("invites")
    .where("token", "==", token)
    .where("accepted", "==", false)
    .limit(1)
    .get();

  if (inviteSnap.empty) {
    throw new functions.https.HttpsError(
      "not-found",
      "Invalid or expired invite.",
    );
  }

  const invite = inviteSnap.docs[0];
  const teamId = invite.data().teamId;
  const uid = context.auth.uid;

  // Get user email to store in team members array
  const userDoc = await db.collection("users").doc(uid).get();
  const email = userDoc.data()?.email || context.auth.token.email || "";

  // Add user to team memberIds array and members array
  await db
    .collection("teams")
    .doc(teamId)
    .update({
      memberIds: admin.firestore.FieldValue.arrayUnion(uid),
      members: admin.firestore.FieldValue.arrayUnion({
        uid,
        email,
        role: "member",
      }),
    });

  // Update user record
  await db.collection("users").doc(uid).update({
    teamId,
    plan: "team",
    role: "member",
  });

  // Mark invite as accepted
  await invite.ref.update({ accepted: true });

  return { teamId };
});

// ── Cloud Function: deleteAccount ─────────────────────────────
// Cancels Paddle subscription, deletes all Firestore data,
// and deletes the Firebase Auth user.
exports.deleteAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in.",
    );
  }

  const uid = context.auth.uid;

  // 1. Get user profile to find Paddle subscription ID
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data() || {};
  const paddleSubId = userData.paddleSubId;

  // 2. Cancel Paddle subscription if exists
  if (paddleSubId) {
    try {
      const paddleApiKey = process.env.PADDLE_API_KEY;
      const response = await fetch(
        `https://api.paddle.com/subscriptions/${paddleSubId}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paddleApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ effective_from: "immediately" }),
        },
      );
      if (!response.ok) {
        const err = await response.json();
        functions.logger.error("[deleteAccount] Paddle cancel error:", err);
        // Don't throw — still delete the account even if Paddle call fails
      } else {
        functions.logger.info(
          "[deleteAccount] Paddle subscription cancelled:",
          paddleSubId,
        );
      }
    } catch (err) {
      functions.logger.error("[deleteAccount] Paddle API error:", err);
      // Continue with deletion even if Paddle fails
    }
  }

  // 3. Delete all user's entries in batches
  const entriesSnap = await db
    .collection("entries")
    .where("userId", "==", uid)
    .get();

  const batchSize = 400;
  for (let i = 0; i < entriesSnap.docs.length; i += batchSize) {
    const batch = db.batch();
    entriesSnap.docs
      .slice(i, i + batchSize)
      .forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  // 4. Delete user Firestore document
  await db.collection("users").doc(uid).delete();

  // 5. Delete Firebase Auth user
  await admin.auth().deleteUser(uid);

  functions.logger.info("[deleteAccount] Account deleted:", uid);
  return { success: true };
});
