/**
 * Notify Velo mobile app via FCM when a website order is paid.
 * Requires VELO_PUSH_NOTIFY_URL and VELO_PUSH_WEBHOOK_SECRET on the shop.
 */
import db from "@/lib/supabase/db";
import { orderLines, products } from "@/lib/supabase/schema";
import { eq } from "drizzle-orm";

export type VeloPushOrderParams = {
  orderId: string;
  customerName: string;
  customerMobile?: string | null;
};

function shopBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_VERCEL_URL?.trim() ||
    "https://sakthi-textiles-shop.vercel.app";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

async function orderLineSummary(orderId: string): Promise<{
  quantity: number;
  itemSummary: string;
}> {
  const lines = await db
    .select({
      productName: products.name,
      quantity: orderLines.quantity,
    })
    .from(orderLines)
    .leftJoin(products, eq(orderLines.productId, products.id))
    .where(eq(orderLines.orderId, orderId));

  const quantity = lines.reduce(
    (sum, line) => sum + (Number(line.quantity) || 0),
    0,
  );
  const firstName = lines.find((l) => l.productName?.trim())?.productName?.trim();
  return {
    quantity: quantity > 0 ? quantity : 1,
    itemSummary: firstName ?? "",
  };
}

export async function notifyVeloAppNewPaidOrder(
  params: VeloPushOrderParams,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const url = process.env.VELO_PUSH_NOTIFY_URL?.trim();
  const secret = process.env.VELO_PUSH_WEBHOOK_SECRET?.trim();
  if (!url || !secret) {
    return { ok: false, skipped: true };
  }

  try {
    const { quantity, itemSummary } = await orderLineSummary(params.orderId);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-velo-push-secret": secret,
      },
      body: JSON.stringify({
        shopBaseUrl: shopBaseUrl(),
        orderId: params.orderId,
        customerName: params.customerName?.trim() || "Customer",
        quantity,
        itemSummary,
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[VeloPush] notify failed:", res.status, text);
      return { ok: false, error: `Push notify returned ${res.status}` };
    }

    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message || "Push notify failed";
    console.warn("[VeloPush]", msg);
    return { ok: false, error: msg };
  }
}
