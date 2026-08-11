
const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("RAZORPAY_WEBHOOK_SECRET is missing");
      return { statusCode: 500, body: "Webhook secret not configured" };
    }

    const signature = event.headers?.["x-razorpay-signature"] ||
      event.headers?.["X-Razorpay-Signature"];

    if (!signature || !event.body) {
      return { statusCode: 400, body: "Missing signature or body" };
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(event.body, "utf8")
      .digest("hex");

    if (signature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return { statusCode: 400, body: "Invalid signature" };
    }

    const data = JSON.parse(event.body);
    const eventName = data.event || "";
    const payment = getPaymentEntity(data);
    const subscription = getSubscriptionEntity(data);

    // Keep every Razorpay payment in a separate audit collection.
    if (payment?.id) {
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
    }

    // Only successful payment events change customer balance/history.
    if (!isSuccessfulEvent(eventName, payment) || !payment?.id) {
      return { statusCode: 200, body: "Event received" };
    }

    const customerDoc = await findCustomer(payment, subscription);

    if (!customerDoc) {
      console.warn("No matching customer", {
        paymentId: payment.id,
        contact: payment.contact,
        email: payment.email,
        event: eventName
      });
      return { statusCode: 200, body: "Payment received; customer not matched" };
    }

    const customerRef = customerDoc.ref;
    const paymentAmount = Number(payment.amount || 0) / 100;
    const paymentId = String(payment.id);
    const now = new Date();

    await db.runTransaction(async tx => {
      const freshSnap = await tx.get(customerRef);
      if (!freshSnap.exists) return;

      const customer = freshSnap.data() || {};
      const history = Array.isArray(customer.history) ? [...customer.history] : [];

      // Razorpay may retry webhooks; do not count the same payment twice.
      if (history.some(h => String(h.payment_id || "") === paymentId)) return;

      const weekKey = getWeekKey(now);
      const mode = paymentModeFor(eventName);

      history.push({
        date: now.toLocaleDateString("en-IN"),
        amount: paymentAmount,
        status: `SUCCESS (${mode})`,
        paymentMode: mode,
        event: eventName,
        payment_id: paymentId,
        subscription_id: subscription?.id || payment.subscription_id || "",
        weekKey
      });

      const paidTotal = history.reduce((sum, h) => {
        return String(h?.status || "").includes("SUCCESS")
          ? sum + (Number(h.amount) || 0)
          : sum;
      }, 0);

      const totalLoan = Number(customer.totalLoan || 0);
      const remainingBalance = Math.max(0, totalLoan - paidTotal);

      tx.update(customerRef, {
        history,
        remainingBalance,
        lastPaymentAmount: paymentAmount,
        lastPaymentDate: now.toLocaleDateString("en-IN"),
        lastPaymentMode: mode,
        hasFailedDeduction: false,
        lastDeductedWeek: eventName === "subscription.charged"
          ? weekKey
          : (customer.lastDeductedWeek || "")
      });
    });

    console.log("Payment processed", {
      paymentId,
      customerId: customerDoc.id,
      amount: paymentAmount,
      mode: paymentModeFor(eventName)
    });

    return { statusCode: 200, body: "Payment processed" };
  } catch (error) {
    console.error("Webhook error:", error);
    return { statusCode: 500, body: "Webhook processing error" };
  }
};

function getWeekKey(dateObj = new Date()) {
  const today = new Date(dateObj);
  return today.getFullYear() + "-W" +
    Math.ceil((today.getDate() - today.getDay()) / 7);
}
