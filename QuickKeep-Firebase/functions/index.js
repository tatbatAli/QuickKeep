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
const functionsV1 = require("firebase-functions/v1");
const admin = require("firebase-admin");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// ── Zoho SMTP transporter ─────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_PASSWORD,
  },
});

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

      // ── Cancelled → schedule downgrade at period end ─────────
      case "subscription.cancelled": {
        const userData = userDoc.data();
        const scheduledDate = event.data?.scheduled_change?.effective_at;
        const effectiveDate = scheduledDate
          ? new Date(scheduledDate)
          : new Date();
        const isImmediate = effectiveDate <= new Date();

        if (isImmediate) {
          await downgradeUserAndTeam(userDoc);
          functions.logger.info(`[Paddle] Immediately downgraded ${email}`);
        } else {
          await userDoc.ref.update({
            pendingCancel: true,
            cancelledAt: effectiveDate,
          });
          functions.logger.info(
            `[Paddle] Scheduled downgrade for ${email} at ${effectiveDate}`,
          );
        }
        break;
      }

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

  const userDoc = await db.collection("users").doc(uid).get();
  if (!["team"].includes(userDoc.data()?.plan)) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Team plan required.",
    );
  }

  const teamRef = await db.collection("teams").add({
    name: teamName,
    ownerId: uid,
    memberIds: [uid],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db
    .collection("users")
    .doc(uid)
    .update({ teamId: teamRef.id, role: "owner" });

  return { teamId: teamRef.id };
});

// ── Cloud Function: acceptInvite ──────────────────────────────
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

  const userDoc = await db.collection("users").doc(uid).get();
  const email = userDoc.data()?.email || context.auth.token.email || "";

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

  await db.collection("users").doc(uid).update({
    teamId,
    plan: "team",
    role: "member",
  });

  await invite.ref.update({ accepted: true });

  return { teamId };
});

// ── Cloud Function: deleteAccount ─────────────────────────────
exports.deleteAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in.",
    );
  }

  const uid = context.auth.uid;

  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data() || {};
  const paddleSubId = userData.paddleSubId;

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
      } else {
        functions.logger.info(
          "[deleteAccount] Paddle subscription cancelled:",
          paddleSubId,
        );
      }
    } catch (err) {
      functions.logger.error("[deleteAccount] Paddle API error:", err);
    }
  }

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

  await db.collection("users").doc(uid).delete();
  await admin.auth().deleteUser(uid);

  functions.logger.info("[deleteAccount] Account deleted:", uid);
  return { success: true };
});

// ── Cloud Function: sendVerificationEmail ────────────────────
exports.sendVerificationEmail = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be logged in.",
      );
    }

    const email = context.auth.token.email;

    const link = await admin.auth().generateEmailVerificationLink(email);

    await transporter.sendMail({
      from: '"QuickKeep" <support@quickkeep.icu>',
      to: email,
      subject: "Verify your QuickKeep email ✦",
      html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f1a;border-radius:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;">
          <div style="width:28px;height:28px;background:#6366f1;border-radius:8px;display:flex;align-items:center;justify-content:center;">
            <span style="color:white;font-size:14px;">✦</span>
          </div>
          <span style="color:#f0f0f8;font-size:16px;font-weight:700;">QuickKeep</span>
        </div>
        <h2 style="color:#f0f0f8;margin:0 0 8px;">Welcome to QuickKeep</h2>
        <p style="color:#a0a0b8;line-height:1.6;">
          Click below to verify your email and unlock your <strong style="color:#a5b4fc;">7-day Pro trial</strong> — no credit card needed.
        </p>
        <a href="${link}"
           style="display:inline-block;margin:24px 0;padding:14px 28px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
          Verify my email →
        </a>
        <p style="color:#606080;font-size:12px;line-height:1.6;">
          This link expires in 24 hours.<br>
          If you didn't create a QuickKeep account, you can safely ignore this email.
        </p>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);color:#404060;font-size:11px;">
          QuickKeep · support@quickkeep.icu
        </div>
      </div>
    `,
    });

    functions.logger.info(`[sendVerificationEmail] Sent to ${email}`);
    return { sent: true };
  },
);

// ── Helper: downgrade user + dissolve their team ─────────────
async function downgradeUserAndTeam(userDoc) {
  const userData = userDoc.data();
  const teamId = userData?.teamId;

  await userDoc.ref.update({
    plan: "free",
    paddleSubId: null,
    teamId: null,
    role: "member",
    pendingCancel: false,
    cancelledAt: null,
  });

  if (teamId) {
    const teamDoc = await db.collection("teams").doc(teamId).get();
    if (teamDoc.exists) {
      const memberIds = teamDoc.data()?.memberIds || [];

      const memberUpdates = memberIds
        .filter((mid) => mid !== userDoc.id)
        .map((mid) =>
          db.collection("users").doc(mid).update({
            plan: "free",
            teamId: null,
            role: "member",
          }),
        );
      await Promise.all(memberUpdates);

      await teamDoc.ref.delete();
    }
  }
}

// ── Cloud Function: getCustomerPortalUrl ─────────────────────
exports.getCustomerPortalUrl = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in.",
    );
  }

  const uid = context.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();

  if (!userData?.paddleSubId) {
    throw new functions.https.HttpsError(
      "not-found",
      "No active subscription found.",
    );
  }

  const PADDLE_API_KEY = process.env.PADDLE_API_KEY;

  const subRes = await fetch(
    `https://api.paddle.com/subscriptions/${userData.paddleSubId}`,
    { headers: { Authorization: `Bearer ${PADDLE_API_KEY}` } },
  );
  const subData = await subRes.json();
  const customerId = subData?.data?.customer_id;

  if (!customerId) {
    throw new functions.https.HttpsError(
      "not-found",
      "Paddle customer not found.",
    );
  }

  const portalRes = await fetch(
    `https://api.paddle.com/customers/${customerId}/portal-sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  const portalData = await portalRes.json();
  const portalUrl = portalData?.data?.urls?.general?.overview;

  if (!portalUrl) {
    throw new functions.https.HttpsError(
      "internal",
      "Could not generate portal URL.",
    );
  }

  return { url: portalUrl };
});

// ── Scheduled Function: process pending cancellations ────────
exports.processPendingCancellations = functionsV1.pubsub
  .schedule("0 0 * * *")
  .timeZone("UTC")
  .onRun(async (context) => {
    const now = new Date();
    const snap = await db
      .collection("users")
      .where("pendingCancel", "==", true)
      .where("cancelledAt", "<=", now)
      .get();

    if (snap.empty) {
      functions.logger.info("[scheduler] No pending cancellations to process");
      return;
    }

    functions.logger.info(
      `[scheduler] Processing ${snap.docs.length} cancellations`,
    );

    for (const doc of snap.docs) {
      try {
        await downgradeUserAndTeam(doc);
        functions.logger.info(`[scheduler] Downgraded ${doc.data()?.email}`);
      } catch (err) {
        functions.logger.error(
          `[scheduler] Failed to downgrade ${doc.id}:`,
          err,
        );
      }
    }
  });

// ── Scheduled Function: delete expired trial data after 15-day grace period ──
exports.processExpiredTrialData = functionsV1.pubsub
  .schedule("0 1 * * *")
  .timeZone("UTC")
  .onRun(async (context) => {
    const now = new Date();
    const snap = await db
      .collection("users")
      .where("plan", "==", "free")
      .where("dataExpiresAt", "<=", now)
      .get();

    if (snap.empty) {
      functions.logger.info("[scheduler] No expired trial data to delete");
      return;
    }

    functions.logger.info(
      `[scheduler] Deleting data for ${snap.docs.length} expired users`,
    );

    for (const doc of snap.docs) {
      const uid = doc.id;
      try {
        const entries = await db
          .collection("entries")
          .where("userId", "==", uid)
          .where("teamId", "==", null)
          .get();
        const batch = db.batch();
        entries.docs.forEach((e) => batch.delete(e.ref));
        await batch.commit();

        const folders = await db
          .collection("folders")
          .where("userId", "==", uid)
          .get();
        const batch2 = db.batch();
        folders.docs.forEach((f) => batch2.delete(f.ref));
        await batch2.commit();

        await doc.ref.update({
          dataExpiresAt: admin.firestore.FieldValue.delete(),
        });

        functions.logger.info(`[scheduler] Deleted data for user ${uid}`);
      } catch (err) {
        functions.logger.error(
          `[scheduler] Failed to delete data for ${uid}:`,
          err,
        );
      }
    }
  });

// ── Scheduled Function: delete unverified accounts after 24h ─
// Runs daily at 2am UTC. Cleans up ghost accounts where the
// user registered but never clicked the verification link.
exports.deleteUnverifiedAccounts = functionsV1.pubsub
  .schedule("0 2 * * *")
  .timeZone("UTC")
  .onRun(async (context) => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago

    const snap = await db
      .collection("users")
      .where("verified", "==", false)
      .where("createdAt", "<=", cutoff)
      .get();

    if (snap.empty) {
      functions.logger.info("[scheduler] No unverified accounts to clean up");
      return;
    }

    functions.logger.info(
      `[scheduler] Deleting ${snap.docs.length} unverified accounts`,
    );

    for (const doc of snap.docs) {
      const uid = doc.id;
      const email = doc.data()?.email;
      try {
        // Delete Firebase Auth account
        try {
          await admin.auth().deleteUser(uid);
        } catch (authErr) {
          // Already deleted from Auth or never fully created — continue
          functions.logger.warn(
            `[scheduler] Auth delete skipped for ${uid}:`,
            authErr.message,
          );
        }

        // Delete Firestore document
        await doc.ref.delete();

        functions.logger.info(
          `[scheduler] Deleted unverified account: ${email} (${uid})`,
        );
      } catch (err) {
        functions.logger.error(
          `[scheduler] Failed to delete unverified account ${uid}:`,
          err,
        );
      }
    }
  });
