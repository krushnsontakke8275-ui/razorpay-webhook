const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    console.log(event.headers);
    const signature = event.headers["x-razorpay-signature"];
    console.log("Signature:", signature);
    console.log("Secret:", webhookSecret);
    console.log("Body:", event.body);
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(event.body)
      .digest("hex");

    if (signature !== expectedSignature) {
      return {
        statusCode: 400,
        body: "Invalid signature"
      };
    }

    const data = JSON.parse(event.body);

    const payment = data.payload.payment.entity;

    await db.collection("payments").add({console.log("Payment saved to Firestore");
      payment_id: payment.id,
      amount: payment.amount / 100,
      status: payment.status,
      customer: payment.email || "",
      createdAt: new Date()
    });

    return {
      statusCode: 200,
      body: "Webhook received"
    };
    } catch (error) {
  console.error(error);

  return {
    statusCode: 500,
    body: error.stack
  };
}
  
};
