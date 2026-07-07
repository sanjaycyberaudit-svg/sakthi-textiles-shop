import db from "@/lib/supabase/db";
import { address, orders } from "@/lib/supabase/schema";
import {
  fetchVeloOrderLineRows,
  mapVeloOrderLineItem,
} from "@/lib/integrations/velo-order-lines";
import {
  resolveVeloApiKey,
  touchVeloApiKeyUsage,
} from "@/lib/integrations/velo";
import { and, eq, inArray, ne } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

const VELO_CORS_ORIGINS = new Set([
  "https://software-saree-order.vercel.app",
  "http://localhost:3000",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
]);

function veloCorsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin") ?? "";
  const allowOrigin = VELO_CORS_ORIGINS.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-velo-key",
    "Access-Control-Max-Age": "86400",
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: veloCorsHeaders(request),
  });
}

function extractApiKey(request: NextRequest) {
  const headerKey = request.headers.get("x-velo-key")?.trim();
  if (headerKey) return headerKey;

  const auth = request.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

export async function GET(
  request: NextRequest,
  context: { params: { orderId: string } },
) {
  const { orderId } = context.params;
  const trimmedId = orderId?.trim();
  if (!trimmedId) {
    return NextResponse.json(
      { message: "orderId is required" },
      { status: 400, headers: veloCorsHeaders(request) },
    );
  }

  const apiKey = extractApiKey(request);
  const resolvedKey = await resolveVeloApiKey(apiKey);
  if (!resolvedKey) {
    return NextResponse.json(
      { message: "Unauthorized" },
      { status: 401, headers: veloCorsHeaders(request) },
    );
  }
  await touchVeloApiKeyUsage(resolvedKey.id);

  const [orderRow] = await db
    .select({
      id: orders.id,
      amount: orders.amount,
      currency: orders.currency,
      email: orders.email,
      name: orders.name,
      createdAt: orders.createdAt,
      paymentStatus: orders.payment_status,
      paymentMethod: orders.payment_method,
      paymentProvider: orders.payment_provider,
      paymentReference: orders.payment_reference,
      customerMobile: orders.customer_mobile,
      orderStatus: orders.order_status,
      addressId: orders.addressId,
    })
    .from(orders)
    .where(
      and(
        eq(orders.id, trimmedId),
        inArray(orders.payment_status, ["paid", "unpaid", "no_payment_required"]),
        ne(orders.order_status, "cancelled"),
      ),
    )
    .limit(1);

  if (!orderRow) {
    return NextResponse.json(
      { message: "Order not found" },
      { status: 404, headers: veloCorsHeaders(request) },
    );
  }

  const lineRows = await fetchVeloOrderLineRows([orderRow.id]);
  const items = lineRows.map(mapVeloOrderLineItem);

  let addressPayload = null;
  if (orderRow.addressId) {
    const [addr] = await db
      .select({
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        postalCode: address.postal_code,
        country: address.country,
      })
      .from(address)
      .where(eq(address.id, orderRow.addressId))
      .limit(1);
    addressPayload = addr ?? null;
  }

  return NextResponse.json(
    {
      client: resolvedKey.clientName,
      order: {
        orderId: orderRow.id,
        createdAt: orderRow.createdAt,
        amount: Number(orderRow.amount),
        currency: orderRow.currency,
        orderStatus: orderRow.orderStatus,
        paymentStatus: orderRow.paymentStatus,
        paymentMethod: orderRow.paymentMethod,
        paymentProvider: orderRow.paymentProvider,
        paymentReference: orderRow.paymentReference,
        customer: {
          name: orderRow.name,
          email: orderRow.email,
          mobile: orderRow.customerMobile,
        },
        address: addressPayload,
        items,
      },
    },
    { headers: veloCorsHeaders(request) },
  );
}
