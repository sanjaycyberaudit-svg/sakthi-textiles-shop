import db from "@/lib/supabase/db";
import { medias, productMedias, products } from "@/lib/supabase/schema";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { keytoUrl } from "@/lib/utils";

/**
 * Resolve public image URLs for products (draft + published).
 * Prefer featured_image_id, then first product_medias row by priority.
 */
export async function resolveProductImageUrls(
  productIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return out;

  const featuredRows = await db
    .select({
      productId: products.id,
      imageKey: medias.key,
    })
    .from(products)
    .leftJoin(medias, eq(products.featuredImageId, medias.id))
    .where(inArray(products.id, ids));

  for (const row of featuredRows) {
    if (row.imageKey) out.set(row.productId, keytoUrl(row.imageKey));
  }

  const missing = ids.filter((id) => !out.has(id));
  if (!missing.length) return out;

  const galleryRows = await db
    .select({
      productId: productMedias.productId,
      imageKey: medias.key,
      priority: productMedias.priority,
    })
    .from(productMedias)
    .innerJoin(medias, eq(productMedias.mediaId, medias.id))
    .where(inArray(productMedias.productId, missing))
    .orderBy(
      asc(sql`coalesce(${productMedias.priority}, 999999)`),
      asc(productMedias.id)
    );

  for (const row of galleryRows) {
    if (!row.imageKey || out.has(row.productId)) continue;
    out.set(row.productId, keytoUrl(row.imageKey));
  }

  return out;
}
