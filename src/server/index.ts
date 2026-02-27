import express from "express";
import cors from "cors";

// Dynamic imports — loaded after env is ready (see server:dev script or --env-file flag)
const { default: webhookRouter } = await import("./routes/webhook.js");
const { default: checkoutRouter } = await import("./routes/checkout.js");
const { default: subscriptionRouter } = await import("./routes/subscription.js");
const { default: portalRouter } = await import("./routes/portal.js");

const app = express();
const PORT = process.env.PORT || 3001;

// CORS
const origins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:5500"];
app.use(cors({ origin: origins, credentials: true }));

// Webhook route MUST come before express.json() — needs raw body for signature verification
app.use(webhookRouter);

// JSON parsing
app.use(express.json());

// Clerk auth — skip if no real keys configured (local Stripe-only testing)
const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
if (clerkKey.length > 20) {
  const { clerkAuth } = await import("./middleware/auth.js");
  app.use(clerkAuth);
  console.log("Clerk auth enabled");
} else {
  console.log("Clerk auth disabled (no CLERK_SECRET_KEY)");
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Authenticated routes
app.use(checkoutRouter);
app.use(subscriptionRouter);
app.use(portalRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
