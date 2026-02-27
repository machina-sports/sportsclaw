import { Router } from "express";
import { stripe } from "../lib/stripe.js";
import { findCustomerByClerkId } from "../lib/customers.js";
import { authRequired, getClerkUserId } from "../middleware/auth.js";

const router = Router();

router.post("/api/portal", authRequired, async (req, res) => {
  try {
    const clerkUserId = getClerkUserId(req);
    const customerId = await findCustomerByClerkId(clerkUserId);

    if (!customerId) {
      res.status(404).json({ error: "No billing account found" });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url:
        process.env.PORTAL_RETURN_URL || "https://sportsclaw.gg/#pricing",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Portal error:", err);
    res.status(500).json({ error: "Failed to create portal session" });
  }
});

export default router;
