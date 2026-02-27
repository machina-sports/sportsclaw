import { stripe } from "./stripe.js";

export async function findCustomerByClerkId(
  clerkUserId: string
): Promise<string | null> {
  const result = await stripe.customers.search({
    query: `metadata["clerkUserId"]:"${clerkUserId}"`,
    limit: 1,
  });
  return result.data[0]?.id ?? null;
}

export async function getOrCreateCustomer(
  clerkUserId: string,
  email?: string
): Promise<string> {
  const existing = await findCustomerByClerkId(clerkUserId);
  if (existing) return existing;

  const customer = await stripe.customers.create({
    email,
    metadata: { clerkUserId },
  });
  return customer.id;
}
