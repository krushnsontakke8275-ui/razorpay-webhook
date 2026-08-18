const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const Razorpay = require("razorpay");

const app = express();

// Initialize Razorpay Instance for Auto-Pause API Calls
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "",
  key_secret: process.env.RAZORPAY_KEY_SECRET || ""
});

// Express JSON Middleware to get raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Bulletproof Firebase Admin Initialization with Base64 & Multi-Format Support
if (!admin.apps.length) {
  let serviceAccount = null;

  // 1. Try Base64 Encoded Environment Variable First (Most Reliable for Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64.trim(), 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
      console.log("✅ Successfully parsed FIREBASE_SERVICE_ACCOUNT_BASE64");
    } catch (err) {
      console.error("⚠️ Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64 env var:", err.message);
    }
  }

  // 2. Fallback to Standard Environment Variable
  if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      let envData = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      if (typeof envData === 'string') {
        serviceAccount = JSON.parse(envData);
      }
    } catch (err) {
      console.error("⚠️ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", err.message);
    }
  }

  // 3. Fallback to Local serviceAccountKey.json File Search
  if (!serviceAccount) {
    const possiblePaths = [
      path.join(process.cwd(), "serviceAccountKey.json"),
      path.join(__dirname, "serviceAccountKey.json"),
      path.join(__dirname, "../serviceAccountKey.json"),
      path.join(__dirname, "../../serviceAccountKey.json"),
      "/opt/render/project/src/serviceAccountKey.json"
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        try {
          serviceAccount = JSON.parse(fs.readFileSync(p, "utf8"));
          console.log(`✅ Loaded serviceAccountKey.json from path: ${p}`);
          break;
        } catch (e) {
          console.error(`⚠️ Found file at ${p} but failed to parse:`, e.message);
        }
      }
    }
  }

  // Initialize Admin SDK with Credentials and Cleaned Private Key
  if (serviceAccount) {
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key
        .replace(/\\n/g, '\n')
        .replace(/^"|"$/g, '');
    }

    const projectId = serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID || "krushna-cosmetic";

    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId
      });
      console.log("🚀 Firebase Admin successfully initialized for project:", projectId);
    } catch (initErr) {
      console.error("🔥 Firebase admin.initializeApp error:", initErr.message);
    }
  } else {
    console.error("❌ CRITICAL: No valid Firebase Service Account credentials found!");
  }
}

const db = admin.firestore();

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function getPaymentEntity(data) {
  return data?.payload?.payment?.entity || null;
}

function getSubscriptionEntity(data) {
  return data?.payload?.subscription?.entity || null;
}

function isSuccessfulEvent(eventName, payment) {
  if (eventName === "subscription.charged") return true;
  if (eventName === "payment.captured") return true;
  if (eventName === "order.paid") return true;
  if (eventName === "subscription.authenticated") {
    return !!payment && ["captured", "authorized"].includes(payment.status);
  }
  return false;
}

async function findCustomer(payment, subscription) {
  const contact = normalizeMobile(
    payment?.contact || payment?.notes?.mobile || payment?.notes?.phone ||
    subscription?.notes?.mobile || subscription?.notes?.phone
  );

  const snap = await db.collection("customers").get();

  if (contact) {
    const match = snap.docs.find(doc => {
      const c = doc.data() || {};
      return normalizeMobile(c.mobile) === contact;
    });
    if (match) return match;
  }

  const email = String(payment?.email || "").trim().toLowerCase();
  if (email) {
    const match = snap.docs.find(doc => {
      const c = doc.data() || {};
      return String(c.email || "").trim().toLowerCase() === email;
    });
    if (match) return match;
  }

  return null;
}

function paymentModeFor(eventName) {
  return eventName === "subscription.charged"
    ? "Weekly AutoPay"
    : "Direct UPI / Online";
}

function getWeekKey(dateObj = new Date()) {
  const today = new Date(dateObj);
  return today.getFullYear() + "-W" +
    Math.ceil((today.getDate() - today.getDay()) / 7);
}

// Health Check Endpoint
app.get("/", (req, res) => {
  res.status(200).send("Razorpay Webhook Server is Live!");
});

// Razorpay Webhook Endpoint
app.post(["/webhook/razorpay", "/.netlify/functions/webhook", "/"], async (req, res) => {
  try {
    console.log("📩 Webhook Hit Received on Server!");

    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("❌ ERROR: RAZORPAY_WEBHOOK_SECRET is missing in environment variables!");
      return res.status(500).send("Webhook secret not configured");
    }

    const signature = req.headers["x-razorpay-signature"] || req.headers["X-Razorpay-Signature"];
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

    if (!signature || !rawBody) {
      console.error("❌ ERROR: Missing signature or rawBody!");
      return res.status(400).send("Missing signature or body");
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody, "utf8")
      .digest("hex");

    if (signature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      console.error("❌ ERROR: Signature Verification Failed! Check RAZORPAY_WEBHOOK_SECRET in Render.");
      return res.status(400).send("Invalid signature");
    }

    console.log("✅ Signature Verified Successfully!");

    const data = req.body;
    const eventName = data.event || "";
    console.log(`📌 Event Received: "${eventName}"`);

    const payment = getPaymentEntity(data);
    const subscription = getSubscriptionEntity(data);

    if (!payment) {
      console.log("⚠️ WARNING: No payment entity found in payload!");
      console.log("Payload data structure:", JSON.stringify(data.payload || {}));
    } else {
      console.log(`💳 Extracted Payment ID: ${payment.id}, Status: ${payment.status}, Amount: ${payment.amount / 100}`);
    }

    // Keep every Razorpay payment in a separate audit collection.
    if (payment?.id) {
      console.log(`💾 Attempting to save payment document [${payment.id}] to Firestore 'payments' collection...`);
      await db.collection("payments").doc(String(payment.id)).set({
        payment_id: payment.id,
        amount: Number(payment.amount || 0) / 100,
        status: payment.status || "",
        event: eventName,
        customer: payment.email || "",
        contact: payment.contact || "",
        subscription_id: subscription?.id || payment.subscription_id || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`✅ SUCCESS: Saved payment [${payment.id}] to Firestore 'payments' collection!`);
    } else {
      console.log("⚠️ Payment ID missing. Skipped saving to 'payments' collection.");
    }

    // Only successful payment events change customer balance/history.
    if (!isSuccessfulEvent(eventName, payment) || !payment?.id) {
      console.log(`ℹ️ Event "${eventName}" is not classified as a balance-updating successful event. Stopping here.`);
      return res.status(200).send("Event received");
    }

    const customerDoc = await findCustomer(payment, subscription);

    if (!customerDoc) {
      console.warn("⚠️ No matching customer found in 'customers' collection for:", {
        paymentId: payment.id,
        contact: payment.contact,
        email: payment.email,
        event: eventName
      });
      return res.status(200).send("Payment received; customer not matched");
    }

    console.log(`👤 Matched Customer ID: ${customerDoc.id}`);

    const customerRef = customerDoc.ref;
    const paymentAmount = Number(payment.amount || 0) / 100;
    const paymentId = String(payment.id);
    const subId = subscription?.id || payment.subscription_id || "";
    const now = new Date();

    let finalRemainingBalance = 0;

    await db.runTransaction(async tx => {
      const freshSnap = await tx.get(customerRef);
      if (!freshSnap.exists) return;

      const customer = freshSnap.data() || {};
      const history = Array.isArray(customer.history) ? [...customer.history] : [];

      if (history.some(h => String(h.payment_id || "") === paymentId)) {
        console.log(`ℹ️ Payment ID ${paymentId} already present in customer history. Duplicate skipped.`);
        return;
      }

      const weekKey = getWeekKey(now);
      const mode = paymentModeFor(eventName);

      history.push({
        date: now.toLocaleDateString("en-IN"),
        amount: paymentAmount,
        status: `SUCCESS (${mode})`,
        paymentMode: mode,
        event: eventName,
        payment_id: paymentId,
        subscription_id: subId,
        weekKey
      });

      const paidTotal = history.reduce((sum, h) => {
        return String(h?.status || "").includes("SUCCESS")
          ? sum + (Number(h.amount) || 0)
          : sum;
      }, 0);

      const totalLoan = Number(customer.totalLoan || 0);
      finalRemainingBalance = Math.max(0, totalLoan - paidTotal);

      tx.update(customerRef, {
        history,
        remainingBalance: finalRemainingBalance,
        lastPaymentAmount: paymentAmount,
        lastPaymentDate: now.toLocaleDateString("en-IN"),
        lastPaymentMode: mode,
        hasFailedDeduction: false,
        lastDeductedWeek: eventName === "subscription.charged"
          ? weekKey
          : (customer.lastDeductedWeek || "")
      });
    });

    console.log("🎉 Payment processed and customer record updated successfully!", {
      paymentId,
      customerId: customerDoc.id,
      amount: paymentAmount,
      remainingBalance: finalRemainingBalance,
      mode: paymentModeFor(eventName)
    });

    // 🛑 AUTO-PAUSE SUBSCRIPTION IF REMAINING BALANCE REACHES 0 🛑
    if (finalRemainingBalance <= 0 && subId) {
      try {
        console.log(`⏸️ Balance is 0. Attempting to pause AutoPay Subscription: ${subId}`);
        await razorpay.subscriptions.pause(subId, { pause_at: "now" });
        console.log(`✅ AutoPay successfully PAUSED for Subscription ID: ${subId}`);
      } catch (pauseErr) {
        console.error(`❌ Failed to pause AutoPay subscription [${subId}]:`, pauseErr.message);
      }
    }

    return res.status(200).send("Payment processed");
  } catch (error) {
    console.error("🔥 Webhook processing error:", error);
    return res.status(500).send("Webhook processing error");
  }
});

// Express App Listener for Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Razorpay Webhook Server listening on port ${PORT}`);
});
