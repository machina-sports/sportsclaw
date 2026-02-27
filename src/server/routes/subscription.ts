import { Router } from "express";
import { stripe, PRICE_IDS } from "../lib/stripe.js";
import { findCustomerByClerkId } from "../lib/customers.js";
import { authRequired, getClerkUserId } from "../middleware/auth.js";
import type { PlanId, SubscriptionStatusResponse } from "../types.js";

const router = Router();

// Reverse lookup: price ID → plan name
const PRICE_TO_PLAN = new Map<string, PlanId>(
  Object.entries(PRICE_IDS).map(([plan, priceId]) => [priceId, plan as PlanId])
);

router.get("/api/subscription", authRequired, async (req, res) => {
  try {
    const clerkUserId = getClerkUserId(req);
    const customerId = await findCustomerByClerkId(clerkUserId);

    if (!customerId) {
      const response: SubscriptionStatusResponse = {
        status: "none",
        planId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      };
      res.json(response);
      return;
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
      expand: ["data.items.data.price"],
    });

    // Find the first active or past_due subscription
    const active = subscriptions.data.find(
      (sub) => sub.status === "active" || sub.status === "past_due"
    );

    if (!active) {
      const response: SubscriptionStatusResponse = {
        status: "none",
        planId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      };
      res.json(response);
      return;
    }

    const firstItem = active.items.data[0];
    const priceId = firstItem?.price?.id;
    const planId = priceId ? PRICE_TO_PLAN.get(priceId) ?? null : null;

    const response: SubscriptionStatusResponse = {
      status: active.status as "active" | "past_due",
      planId,
      currentPeriodEnd: firstItem?.current_period_end ?? null,
      cancelAtPeriodEnd: active.cancel_at_period_end,
    };
    res.json(response);
  } catch (err) {
    console.error("Subscription status error:", err);
    res.status(500).json({ error: "Failed to retrieve subscription status" });
  }
});

export default router;
