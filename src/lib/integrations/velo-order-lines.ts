import db from "@/lib/supabase/db";
import { medias, orderLines, products } from "@/lib/supabase/schema";
import { eq, inArray } from "drizzle-orm";
import { keytoUrl } from "@/lib/utils";

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
  imageKey: string | null;
};

export async function fetchVeloOrderLineRows(
  orderIds: string[],
): Promise<LineRow[]> {
  if (!orderIds.length) return [];

  return db
    .select({
      orderId: orderLines.orderId,
      productId: orderLines.productId,
      quantity: orderLines.quantity,
      price: orderLines.price,
      productName: products.name,
      productCode: products.productCode,
      imageKey: medias.key,
    })
    .from(orderLines)
    .leftJoin(products, eq(orderLines.productId, products.id))
    .leftJoin(medias, eq(products.featuredImageId, medias.id))
    .where(inArray(orderLines.orderId, orderIds));
}

export function mapVeloOrderLineItem(row: LineRow): VeloOrderLineItem {
  return {
    productId: row.productId,
    productName: row.productName ?? null,
    productCode: row.productCode ?? null,
    quantity: row.quantity,
    unitPrice: Number(row.price),
    imageUrl: keytoUrl(row.imageKey ?? undefined),
  };
}

export function groupVeloOrderLines(rows: LineRow[]): Map<string, VeloOrderLineItem[]> {
  const map = new Map<string, VeloOrderLineItem[]>();
  for (const row of rows) {
    const current = map.get(row.orderId) ?? [];
    current.push(mapVeloOrderLineItem(row));
    map.set(row.orderId, current);
  }
  return map;
}
