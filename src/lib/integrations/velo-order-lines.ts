import db from "@/lib/supabase/db";
import { orderLines, products } from "@/lib/supabase/schema";
import { eq, inArray } from "drizzle-orm";
import { resolveProductImageUrls } from "./velo-product-images";

export type VeloOrderLineItem = {
  productId: string;
  productName: string | null;
  productCode: string | null;
  quantity: number;
  unitPrice: number;
  imageUrl: string;
};

type LineRow = {
  orderId: string;
  productId: string;
  quantity: number;
  price: string;
  productName: string | null;
  productCode: string | null;
};

export async function fetchVeloOrderLineRows(
  orderIds: string[]
): Promise<(LineRow & { imageUrl: string })[]> {
  if (!orderIds.length) return [];

  const rows = await db
    .select({
      orderId: orderLines.orderId,
      productId: orderLines.productId,
      quantity: orderLines.quantity,
      price: orderLines.price,
      productName: products.name,
      productCode: products.productCode,
    })
    .from(orderLines)
    .leftJoin(products, eq(orderLines.productId, products.id))
    .where(inArray(orderLines.orderId, orderIds));

  const imageByProductId = await resolveProductImageUrls(
    rows.map((r) => r.productId)
  );

  return rows.map((row) => ({
    ...row,
    imageUrl: imageByProductId.get(row.productId) ?? "",
  }));
}

export function mapVeloOrderLineItem(
  row: LineRow & { imageUrl: string }
): VeloOrderLineItem {
  return {
    productId: row.productId,
    productName: row.productName ?? null,
    productCode: row.productCode ?? null,
    quantity: row.quantity,
    unitPrice: Number(row.price),
    imageUrl: row.imageUrl || "",
  };
}

export function groupVeloOrderLines(
  rows: (LineRow & { imageUrl: string })[]
): Map<string, VeloOrderLineItem[]> {
  const map = new Map<string, VeloOrderLineItem[]>();
  for (const row of rows) {
    const current = map.get(row.orderId) ?? [];
    current.push(mapVeloOrderLineItem(row));
    map.set(row.orderId, current);
  }
  return map;
}
