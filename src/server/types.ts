export type PlanId = "pro" | "max";

export interface CheckoutRequest {
  planId: PlanId;
}

export interface CheckoutResponse {
  url: string;
}

export interface PortalResponse {
  url: string;
}

export interface SubscriptionStatusResponse {
  status: "active" | "past_due" | "canceled" | "none";
  planId: PlanId | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}
