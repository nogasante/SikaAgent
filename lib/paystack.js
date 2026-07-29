import { PAYSTACK_SECRET } from "./env.js";

export async function paystackLink(order, vendor) {
  if (vendor.is_demo) return `DEMO payment — reply PAID to simulate (ref ${order.payment_ref})`;
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `orders+${vendor.id.slice(0, 8)}@sika.agent`,
      amount: order.amount * 100,
      currency: "GHS",
      reference: order.payment_ref,
      metadata: { order_id: order.id, vendor_id: vendor.id },
    }),
  });
  return (await res.json())?.data?.authorization_url ?? "payment link unavailable — the owner will assist";
}
