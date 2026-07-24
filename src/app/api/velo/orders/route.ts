import db from "@/lib/supabase/db";
import { address, orders } from "@/lib/supabase/schema";
import {
  fetchVeloOrderLineRows,
  groupVeloOrderLines,
} from "@/lib/integrations/velo-order-lines";
import {
  resolveVeloApiKey,
  touchVeloApiKeyUsage,
} from "@/lib/integrations/velo";
import { and, asc, desc, gt, inArray, lt, ne, type SQL } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const ALLOWED_PAYMENT_STATUSES = [
  "paid",
  "unpaid",
  "no_payment_required",
] as const;

type PaymentStatusFilter = (typeof ALLOWED_PAYMENT_STATUSES)[number];

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

export async function GET(request: NextRequest) {
  const apiKey = extractApiKey(request);
  const resolvedKey = await resolveVeloApiKey(apiKey);
  if (!resolvedKey) {
    return NextResponse.json(
      { message: "Unauthorized" },
      { status: 401, headers: veloCorsHeaders(request) },
    );
  }
  await touchVeloApiKeyUsage(resolvedKey.id);

  const searchParams = request.nextUrl.searchParams;
  const since = searchParams.get("since");
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const paymentStatusRaw = searchParams.get("paymentStatus")?.trim().toLowerCase();
  let paymentStatuses: PaymentStatusFilter[] = [...ALLOWED_PAYMENT_STATUSES];
  if (paymentStatusRaw) {
    if (
      !ALLOWED_PAYMENT_STATUSES.includes(
        paymentStatusRaw as PaymentStatusFilter,
      )
    ) {
      return NextResponse.json(
        {
          message:
            "Invalid `paymentStatus`. Use paid, unpaid, or no_payment_required.",
        },
        { status: 400, headers: veloCorsHeaders(request) },
      );
    }
    paymentStatuses = [paymentStatusRaw as PaymentStatusFilter];
  }

  let createdAfterDate: Date | null = null;
  if (since) {
    const parsed = new Date(since);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { message: "Invalid `since` format. Use ISO datetime." },
        { status: 400, headers: veloCorsHeaders(request) },
      );
    }
    createdAfterDate = parsed;
  }

  // Optional upper bound for newest-first (sort=desc) pagination.
  const beforeRaw = searchParams.get("before");
  let createdBeforeDate: Date | null = null;
  if (beforeRaw) {
    const parsed = new Date(beforeRaw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { message: "Invalid `before` format. Use ISO datetime." },
        { status: 400, headers: veloCorsHeaders(request) },
      );
    }
    createdBeforeDate = parsed;
  }

  const sortDesc = searchParams.get("sort")?.trim().toLowerCase() === "desc";

  // Default: all valid payment statuses. Optional paymentStatus narrows the set.
  const paymentFilter: SQL = inArray(orders.payment_status, paymentStatuses);
  const activeOrderFilter = ne(orders.order_status, "cancelled");

  const timeFilters: SQL[] = [];
  if (createdAfterDate) timeFilters.push(gt(orders.createdAt, createdAfterDate));
  if (createdBeforeDate) {
    timeFilters.push(lt(orders.createdAt, createdBeforeDate));
  }

  const whereClause = and(
    paymentFilter,
    activeOrderFilter,
    ...timeFilters,
  );

  const orderRows = await db
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
    .where(whereClause)
    .orderBy(sortDesc ? desc(orders.createdAt) : asc(orders.createdAt))
    .limit(limit);

  if (orderRows.length === 0) {
    return NextResponse.json(
      {
        client: resolvedKey.clientName,
        count: 0,
        orders: [],
        nextSince: since ?? null,
        nextBefore: null,
        sort: sortDesc ? "desc" : "asc",
      },
      { headers: veloCorsHeaders(request) },
    );
  }

  const orderIds = orderRows.map((row) => row.id);
  const addressIds = orderRows
    .map((row) => row.addressId)
    .filter((id): id is string => Boolean(id));

  const [lineRows, addressRows] = await Promise.all([
    fetchVeloOrderLineRows(orderIds),
    addressIds.length
      ? db
          .select({
            id: address.id,
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            state: address.state,
            postalCode: address.postal_code,
            country: address.country,
          })
          .from(address)
          .where(inArray(address.id, addressIds))
      : Promise.resolve([]),
  ]);

  const linesByOrder = groupVeloOrderLines(lineRows);

  const addressById = new Map(addressRows.map((row) => [row.id, row]));

  const data = orderRows.map((row) => ({
    orderId: row.id,
    createdAt: row.createdAt,
    amount: Number(row.amount),
    currency: row.currency,
    orderStatus: row.orderStatus,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    paymentProvider: row.paymentProvider,
    paymentReference: row.paymentReference,
    customer: {
      name: row.name,
      email: row.email,
      mobile: row.customerMobile,
    },
    address: row.addressId ? addressById.get(row.addressId) ?? null : null,
    items: (linesByOrder.get(row.id) ?? []).map((line) => ({
      productId: line.productId,
      productName: line.productName,
      productCode: line.productCode,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      imageUrl: line.imageUrl,
    })),
  }));

  return NextResponse.json(
    {
      client: resolvedKey.clientName,
      count: data.length,
      orders: data,
      // Asc sync cursor: newest row in this page.
      nextSince: orderRows[orderRows.length - 1].createdAt,
      // Desc unpaid cursor: oldest row in this page (continue with before=).
      nextBefore: sortDesc
        ? orderRows[orderRows.length - 1].createdAt
        : null,
      sort: sortDesc ? "desc" : "asc",
    },
    { headers: veloCorsHeaders(request) },
  );
}
