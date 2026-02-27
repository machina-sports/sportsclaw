import { Router } from "express";
import { stripe, PRICE_IDS } from "../lib/stripe.js";
import { getOrCreateCustomer } from "../lib/customers.js";
import { authRequired, getClerkUserId } from "../middleware/auth.js";
import type { CheckoutRequest, PlanId } from "../types.js";

const VALID_PLANS: PlanId[] = ["pro", "max"];

const router = Router();

router.post("/api/checkout", authRequired, async (req, res) => {
  try {
    const { planId } = req.body as CheckoutRequest;

    if (!planId || !VALID_PLANS.includes(planId)) {
      res.status(400).json({ error: "Invalid planId. Must be 'pro' or 'max'" });
      return;
    }

    const priceId = PRICE_IDS[planId];
    if (!priceId) {
      res.status(500).json({ error: `No price ID configured for plan: ${planId}` });
      return;
    }

    const clerkUserId = getClerkUserId(req);
    const customerId = await getOrCreateCustomer(clerkUserId);

    // Check for existing active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length > 0) {
      // Already subscribed — redirect to portal instead
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: process.env.PORTAL_RETURN_URL || "https://sportsclaw.gg/#pricing",
      });
      res.status(409).json({
        error: "Already subscribed",
        portalUrl: portalSession.url,
      });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url:
        process.env.CHECKOUT_SUCCESS_URL ||
        "https://sportsclaw.gg/#pricing?checkout=success",
      cancel_url:
        process.env.CHECKOUT_CANCEL_URL || "https://sportsclaw.gg/#pricing",
      metadata: { clerkUserId },
      subscription_data: {
        metadata: { clerkUserId },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

export default router;
