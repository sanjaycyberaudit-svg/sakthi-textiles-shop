import db from "@/lib/supabase/db";
import { carts, orders } from "@/lib/supabase/schema";
import { notifyOrderWhatsAppTargets } from "@/lib/integrations/whatsapp";
import { notifyVeloAppNewPaidOrder } from "@/lib/integrations/velo-push";
import { fetchPhonePePaymentStatus } from "@/lib/payments/phonepe";
import { fetchCashfreeOrderStatus } from "@/lib/payments/cashfree";
import { eq } from "drizzle-orm";

type SyncInput =
  | { orderId: string; merchantTransactionId?: string | null }
  | { orderId?: string | null; merchantTransactionId: string };

export async function syncPhonePeOrderPayment(input: SyncInput) {
  const currentOrder = input.orderId
    ? await db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
      })
    : await db.query.orders.findFirst({
        where: eq(
          orders.phonepe_merchant_transaction_id,
          input.merchantTransactionId,
        ),
      });

  if (!currentOrder) {
    throw new Error("Order not found for payment sync");
  }

  const merchantTransactionId =
    currentOrder.phonepe_merchant_transaction_id ??
    input.merchantTransactionId ??
    "";

  if (!merchantTransactionId) {
    throw new Error("merchantTransactionId missing for PhonePe status sync");
  }

  const status = await fetchPhonePePaymentStatus(merchantTransactionId);
  const state = status?.state ?? "PENDING";
  const isPaid = state === "COMPLETED";

  const [updated] = await db
    .update(orders)
    .set({
      order_status: isPaid ? "PREPARING" : "pending",
      payment_status: isPaid ? "paid" : "unpaid",
      payment_method: "phonepe",
      payment_provider: "phonepe",
      payment_reference: status?.transactionId ?? merchantTransactionId,
      phonepe_transaction_id: status?.transactionId ?? null,
      phonepe_merchant_transaction_id: merchantTransactionId,
      payment_meta: {
        phonepeState: state,
        responseCode: status?.responseCode ?? null,
        paymentInstrument: status?.paymentInstrument ?? null,
      },
    })
    .where(eq(orders.id, currentOrder.id))
    .returning();

  if (isPaid) {
    const wa = await notifyOrderWhatsAppTargets(updated);
    if (wa.customerNotified || wa.sellerNotified) {
      await db
        .update(orders)
        .set({
          whatsapp_notified: wa.customerNotified
            ? true
            : updated.whatsapp_notified,
          whatsapp_notified_at: wa.customerNotified
            ? new Date().toISOString()
            : updated.whatsapp_notified_at,
          whatsapp_seller_notified: wa.sellerNotified
            ? true
            : updated.whatsapp_seller_notified,
          whatsapp_seller_notified_at: wa.sellerNotified
            ? new Date().toISOString()
            : updated.whatsapp_seller_notified_at,
        })
        .where(eq(orders.id, updated.id));
    }

    if (updated.user_id) {
      await db.delete(carts).where(eq(carts.userId, updated.user_id));
    }

    void notifyVeloAppNewPaidOrder({
      orderId: updated.id,
      customerName: updated.name ?? "Customer",
      customerMobile: updated.customer_mobile,
    });
  }

  return {
    orderId: updated.id,
    state,
    isPaid,
  };
}

export async function syncCashfreeOrderPayment(orderId: string) {
  const currentOrder = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
  });

  if (!currentOrder) {
    throw new Error("Order not found for Cashfree payment sync");
  }

  const status = await fetchCashfreeOrderStatus(orderId);
  const state = String(status.order_status ?? "ACTIVE").toUpperCase();
  const isPaid = state === "PAID";

  const [updated] = await db
    .update(orders)
    .set({
      order_status: isPaid ? "PREPARING" : "pending",
      payment_status: isPaid ? "paid" : "unpaid",
      payment_method: "cashfree",
      payment_provider: "cashfree",
      payment_reference: status.cf_order_id
        ? String(status.cf_order_id)
        : orderId,
      payment_meta: {
        cashfreeOrderId: status.order_id ?? orderId,
        cashfreeCfOrderId: status.cf_order_id
          ? String(status.cf_order_id)
          : null,
        cashfreeOrderStatus: state,
      },
    })
    .where(eq(orders.id, currentOrder.id))
    .returning();

  if (isPaid) {
    const wa = await notifyOrderWhatsAppTargets(updated);
    if (wa.customerNotified || wa.sellerNotified) {
      await db
        .update(orders)
        .set({
          whatsapp_notified: wa.customerNotified
            ? true
            : updated.whatsapp_notified,
          whatsapp_notified_at: wa.customerNotified
            ? new Date().toISOString()
            : updated.whatsapp_notified_at,
          whatsapp_seller_notified: wa.sellerNotified
            ? true
            : updated.whatsapp_seller_notified,
          whatsapp_seller_notified_at: wa.sellerNotified
            ? new Date().toISOString()
            : updated.whatsapp_seller_notified_at,
        })
        .where(eq(orders.id, updated.id));
    }

    if (updated.user_id) {
      await db.delete(carts).where(eq(carts.userId, updated.user_id));
    }

    void notifyVeloAppNewPaidOrder({
      orderId: updated.id,
      customerName: updated.name ?? "Customer",
      customerMobile: updated.customer_mobile,
    });
  }

  return {
    orderId: updated.id,
    state,
    isPaid,
  };
}
