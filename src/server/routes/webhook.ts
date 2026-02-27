import { Router } from "express";
import express from "express";
import { stripe, WEBHOOK_SECRET } from "../lib/stripe.js";

const router = Router();

router.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`Webhook signature verification failed: ${message}`);
      res.status(400).json({ error: `Webhook Error: ${message}` });
      return;
    }

    switch (event.type) {
      case "checkout.session.completed":
        console.log(
          `Checkout completed: ${event.data.object.id} (customer: ${event.data.object.customer})`
        );
        break;

      case "customer.subscription.updated":
        console.log(
          `Subscription updated: ${event.data.object.id} → ${event.data.object.status}`
        );
        break;

      case "customer.subscription.deleted":
        console.log(`Subscription deleted: ${event.data.object.id}`);
        break;

      case "invoice.payment_succeeded":
        console.log(
          `Payment succeeded: invoice ${event.data.object.id} ($${(event.data.object.amount_paid ?? 0) / 100})`
        );
        break;

      case "invoice.payment_failed":
        console.log(
          `Payment failed: invoice ${event.data.object.id} (customer: ${event.data.object.customer})`
        );
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  }
);

export default router;
