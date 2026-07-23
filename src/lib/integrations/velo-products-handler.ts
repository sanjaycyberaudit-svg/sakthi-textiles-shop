import {
  getProductSizeConfigsByProductIds,
  normalizeProductSizeConfig,
  upsertProductSizeConfig,
} from "@/lib/products/sizeConfig";
import { invalidateStorefrontCache } from "@/lib/cache/invalidate-storefront";
import { uploadMediaToSupabase } from "@/lib/storage/uploadMedia";
import db from "@/lib/supabase/db";
import {
  apiSettings,
  collections,
  medias,
  orderLines,
  productMedias,
  products,
} from "@/lib/supabase/schema";
import { resolveProductImageUrls } from "./velo-product-images";
import { keytoUrl, slugify } from "@/lib/utils";
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { z } from "zod";

const IDEM_PREFIX = "velo_idempotency_";
const EXTERNAL_PRODUCT_PREFIX = "velo_external_product_";
const PRODUCT_CODE_LOCK_ID = 873214;
const DEFAULT_SIZES = [
  { size: "36", qty: 1 },
  { size: "38", qty: 1 },
  { size: "40", qty: 1 },
  { size: "42", qty: 1 },
  { size: "44", qty: 1 },
] as const;
const MAX_BULK_ITEMS = 50;
const MAX_LIST_PAGE_SIZE = 50;

const badgeSchema = z
  .enum(["new_product", "best_sale", "featured"])
  .nullable()
  .optional();

function parseDraftFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === "true" || value === "1") return true;
  return false;
}

const draftFlagSchema = z
  .preprocess(parseDraftFlag, z.boolean())
  .default(false);

const sizeConfigSchema = z
  .object({
    enabled: z.boolean(),
    options: z.array(
      z.object({
        size: z.string().trim().max(8),
        qty: z.number().min(0),
      }),
    ),
  })
  .optional();

const upsertDataSchema = z.object({
  productId: z.string().trim().optional(),
  externalProductId: z.string().trim().min(1),
  name: z.string().trim().min(2),
  description: z.string().optional().default(""),
  collectionId: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
  tags: z.array(z.string()).optional().default([]),
  badge: badgeSchema,
  rating: z.string().trim().optional().default("4"),
  price: z.string().trim().min(1),
  stock: z.number().int().min(0).optional().default(1),
  isDraft: draftFlagSchema,
  featuredImageMediaId: z.string().trim().optional(),
  imageBase64: z.string().trim().optional(),
  imageFileName: z.string().trim().optional(),
  sizeConfig: sizeConfigSchema,
});

const listDataSchema = z.object({
  search: z.string().optional().default(""),
  draft: z.enum(["all", "draft", "published"]).optional().default("all"),
  page: z.number().int().min(1).optional().default(1),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_PAGE_SIZE)
    .optional()
    .default(20),
});

const deleteDataSchema = z
  .object({
    productId: z.string().trim().optional(),
    externalProductId: z.string().trim().optional(),
  })
  .refine((value) => Boolean(value.productId || value.externalProductId), {
    message: "Either productId or externalProductId is required.",
  });

const metaDataSchema = z.object({
  type: z.enum(["collections"]),
});

const bulkItemSchema = z
  .object({
    externalProductId: z.string().trim().min(1),
    name: z.string().trim().optional(),
    featuredImageMediaId: z.string().trim().optional(),
    imageBase64: z.string().trim().optional(),
    imageFileName: z.string().trim().optional(),
  })
  .refine((item) => Boolean(item.featuredImageMediaId || item.imageBase64), {
    message: "Each bulk item must include featuredImageMediaId or imageBase64.",
  });

const bulkSharedSchema = z.object({
  namePrefix: z.string().trim().min(2),
  description: z.string().optional().default(""),
  collectionId: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
  tags: z.array(z.string()).optional().default([]),
  badge: badgeSchema,
  rating: z.string().trim().optional().default("4"),
  price: z.string().trim().min(1),
  stock: z.number().int().min(0).optional().default(1),
  isDraft: draftFlagSchema,
  sizeConfig: sizeConfigSchema,
});

const bulkDataSchema = z.object({
  shared: bulkSharedSchema,
  items: z.array(bulkItemSchema).min(1).max(MAX_BULK_ITEMS),
});

export type VeloProductsAction =
  | "list"
  | "upsert"
  | "bulk_upsert"
  | "delete"
  | "meta"
  | "resolveImages"
  | "upsertCollection";

const resolveImagesDataSchema = z.object({
  productIds: z.array(z.string().trim().min(1)).min(1).max(100),
});

const upsertCollectionDataSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  featuredImageMediaId: z.string().trim().min(1).optional(),
  imageBase64: z.string().optional(),
  imageFileName: z.string().optional(),
});

function collectionNameToSlug(name: string) {
  return slugify(name.trim()) || "category";
}

async function buildUniqueCollectionSlug(name: string, excludeId?: string) {
  const base = collectionNameToSlug(name);
  let candidate = base;
  let suffix = 2;

  while (true) {
    const existing = await db
      .select({ id: collections.id })
      .from(collections)
      .where(
        excludeId
          ? and(eq(collections.slug, candidate), ne(collections.id, excludeId))
          : eq(collections.slug, candidate),
      )
      .limit(1);

    if (existing.length === 0) return candidate;

    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

async function revalidateCollectionPages() {
  revalidatePath("/collections");
  revalidatePath("/collections", "layout");
  revalidatePath("/shop");
  revalidatePath("/admin/collections");
  await invalidateStorefrontCache();
}

export type VeloProductsRequest = {
  action: VeloProductsAction;
  requestId: string;
  data: Record<string, unknown>;
};

export type VeloProductsResponse = {
  ok: boolean;
  requestId: string;
  action: VeloProductsAction;
  message?: string;
  errors?: string[];
  [key: string]: unknown;
};

async function getIdempotentResponse(
  requestId: string,
): Promise<VeloProductsResponse | null> {
  if (!requestId.trim()) return null;
  const key = `${IDEM_PREFIX}${requestId.trim()}`;
  const row = await db.query.apiSettings.findFirst({
    where: eq(apiSettings.key, key),
  });
  if (!row?.value) return null;
  return row.value as VeloProductsResponse;
}

async function saveIdempotentResponse(
  requestId: string,
  response: VeloProductsResponse,
) {
  const key = `${IDEM_PREFIX}${requestId.trim()}`;
  await db
    .insert(apiSettings)
    .values({
      key,
      value: response,
      isEnabled: true,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: apiSettings.key,
      set: {
        value: response,
        updatedAt: new Date().toISOString(),
      },
    });
}

function externalProductKey(externalProductId: string) {
  return `${EXTERNAL_PRODUCT_PREFIX}${externalProductId.trim()}`;
}

async function uploadBase64Image(
  base64: string,
  fileName: string,
): Promise<string> {
  const raw = base64.includes(",") ? base64.split(",").pop()! : base64;
  const input = Buffer.from(raw, "base64");
  if (input.length === 0) throw new Error("Empty image data.");

  let processed;
  try {
    const meta = await sharp(input, { animated: true }).metadata();
    if (!meta.width) throw new Error("Invalid image.");
    const resized = await sharp(input, { animated: true })
      .rotate()
      .resize({ width: 2000, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    processed = {
      buffer: resized,
      contentType: "image/webp",
      extension: "webp",
    };
  } catch {
    throw new Error(`Could not process image: ${fileName || "image"}`);
  }

  const key = await uploadMediaToSupabase(
    processed.buffer,
    processed.contentType,
    processed.extension,
    "velo-product",
  );

  const [inserted] = await db
    .insert(medias)
    .values({ alt: fileName || "velo-upload", key })
    .returning({ id: medias.id });

  return inserted.id;
}

async function resolveMediaId(
  featuredImageMediaId?: string,
  imageBase64?: string,
  imageFileName?: string,
): Promise<string> {
  if (featuredImageMediaId) {
    const [row] = await db
      .select({ id: medias.id })
      .from(medias)
      .where(eq(medias.id, featuredImageMediaId))
      .limit(1);
    if (!row) throw new Error("Featured image media not found.");
    return row.id;
  }
  if (imageBase64) {
    return uploadBase64Image(imageBase64, imageFileName || "product.jpg");
  }
  throw new Error(
    "Product image is required (featuredImageMediaId or imageBase64).",
  );
}

async function findProductByExternalId(externalProductId: string) {
  const key = externalProductKey(externalProductId);
  const mapping = await db.query.apiSettings.findFirst({
    where: eq(apiSettings.key, key),
  });
  const mappedProductId = String(
    (mapping?.value as Record<string, unknown> | null)?.productId ?? "",
  ).trim();
  if (mappedProductId) {
    const [mapped] = await db
      .select()
      .from(products)
      .where(eq(products.id, mappedProductId))
      .limit(1);
    if (mapped) return mapped;
  }

  // Backward compatibility when previous sync stored external id in productCode.
  const [legacy] = await db
    .select()
    .from(products)
    .where(eq(products.productCode, externalProductId))
    .limit(1);
  return legacy ?? null;
}

async function saveExternalProductMapping(
  externalProductId: string,
  productId: string,
) {
  const key = externalProductKey(externalProductId);
  await db
    .insert(apiSettings)
    .values({
      key,
      value: {
        externalProductId: externalProductId.trim(),
        productId,
      },
      isEnabled: true,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: apiSettings.key,
      set: {
        value: {
          externalProductId: externalProductId.trim(),
          productId,
        },
        isEnabled: true,
        updatedAt: new Date().toISOString(),
      },
    });
}

async function saveSizeConfig(productId: string, sizeConfig: unknown) {
  if (!sizeConfig) return;
  await upsertProductSizeConfig({
    productId,
    config: normalizeIncomingSizeConfig(sizeConfig),
    updatedBy: null,
  });
}

function normalizeIncomingSizeConfig(sizeConfig: unknown) {
  const normalized = normalizeProductSizeConfig(sizeConfig);
  if (normalized.enabled && normalized.options.length === 0) {
    return {
      enabled: true,
      options: [...DEFAULT_SIZES],
    };
  }
  return normalized;
}

async function createNextProductCode(tx: any) {
  await tx.execute(sql`select pg_advisory_xact_lock(${PRODUCT_CODE_LOCK_ID})`);
  const rows = (await tx.execute(
    sql`select product_code
        from products
        where product_code like 'ST%'
        order by product_code desc
        limit 1`,
  )) as Array<{ product_code: string | null }>;
  const lastCode = rows?.[0]?.product_code ?? null;
  const lastNumber = Number.parseInt(lastCode?.replace(/^ST/, "") ?? "0", 10);
  const nextNumber = Number.isFinite(lastNumber) ? lastNumber + 1 : 1;
  return `ST${String(nextNumber).padStart(6, "0")}`;
}

async function ensureProductMediaLink(productId: string, mediaId: string) {
  const [existing] = await db
    .select({ id: productMedias.id })
    .from(productMedias)
    .where(
      and(
        eq(productMedias.productId, productId),
        eq(productMedias.mediaId, mediaId),
      ),
    )
    .limit(1);
  if (existing) return;
  await db.insert(productMedias).values({
    productId,
    mediaId,
    priority: 1,
  });
}

async function getExternalIdsForProductIds(productIds: string[]) {
  const idSet = new Set(productIds);
  if (idSet.size === 0) return new Map<string, string>();
  const rows = await db
    .select({ key: apiSettings.key, value: apiSettings.value })
    .from(apiSettings)
    .where(sql`${apiSettings.key} like ${`${EXTERNAL_PRODUCT_PREFIX}%`}`);

  const map = new Map<string, string>();
  rows.forEach((row) => {
    const value = (row.value ?? {}) as Record<string, unknown>;
    const productId = String(value.productId ?? "").trim();
    const externalProductId = String(value.externalProductId ?? "").trim();
    if (!productId || !externalProductId) return;
    if (!idSet.has(productId)) return;
    map.set(productId, externalProductId);
  });
  return map;
}

async function performUpsert(data: z.infer<typeof upsertDataSchema>) {
  const sizeConfig = data.sizeConfig
    ? normalizeIncomingSizeConfig(data.sizeConfig)
    : undefined;
  if (sizeConfig?.enabled && sizeConfig.options.length === 0) {
    throw new Error("At least one size row is required when size is enabled.");
  }

  let existing = data.productId
    ? (
        await db
          .select()
          .from(products)
          .where(eq(products.id, data.productId))
          .limit(1)
      )[0] ?? null
    : null;
  if (!existing) {
    existing = await findProductByExternalId(data.externalProductId);
  }

  const mediaId = existing
    ? data.featuredImageMediaId || data.imageBase64
      ? await resolveMediaId(
          data.featuredImageMediaId,
          data.imageBase64,
          data.imageFileName,
        )
      : existing.featuredImageId
    : await resolveMediaId(
        data.featuredImageMediaId,
        data.imageBase64,
        data.imageFileName,
      );

  if (existing) {
    const [updated] = await db
      .update(products)
      .set({
        name: data.name,
        description: data.description,
        collectionId: data.collectionId ?? null,
        tags: data.tags,
        badge: data.badge ?? null,
        rating: data.rating,
        price: data.price,
        stock: data.stock,
        isDraft: data.isDraft,
        featuredImageId: mediaId,
      })
      .where(eq(products.id, existing.id))
      .returning();

    await ensureProductMediaLink(updated.id, mediaId);
    await saveSizeConfig(updated.id, sizeConfig);
    await saveExternalProductMapping(data.externalProductId, updated.id);

    return {
      created: false,
      product: {
        productId: updated.id,
        productCode: updated.productCode,
        slug: updated.slug,
        name: updated.name,
        isDraft: updated.isDraft,
      },
    };
  }

  const created = await db.transaction(async (tx) => {
    const productCode = await createNextProductCode(tx);
    const slug = slugify(`${data.name}-${productCode}`);
    const [inserted] = await tx
      .insert(products)
      .values({
        name: data.name,
        slug,
        productCode,
        description: data.description,
        collectionId: data.collectionId ?? null,
        tags: data.tags,
        badge: data.badge ?? null,
        rating: data.rating,
        price: data.price,
        stock: data.stock,
        isDraft: data.isDraft,
        featuredImageId: mediaId,
      })
      .returning();
    return inserted;
  });

  await ensureProductMediaLink(created.id, mediaId);
  await saveSizeConfig(created.id, sizeConfig);
  await saveExternalProductMapping(data.externalProductId, created.id);

  return {
    created: true,
    product: {
      productId: created.id,
      productCode: created.productCode,
      slug: created.slug,
      name: created.name,
      isDraft: created.isDraft,
    },
  };
}

export async function handleVeloProductsRequest(
  body: VeloProductsRequest,
): Promise<VeloProductsResponse> {
  const requestId = String(body.requestId ?? "").trim();
  if (!requestId) {
    return {
      ok: false,
      requestId: "",
      action: body.action,
      message: "requestId is required.",
      errors: ["requestId is required."],
    };
  }

  const cached = await getIdempotentResponse(requestId);
  if (cached) return cached;

  let response: VeloProductsResponse;

  try {
    switch (body.action) {
      case "list":
        response = await handleList(requestId, body.data);
        break;
      case "upsert":
        response = await handleUpsert(requestId, body.data);
        break;
      case "bulk_upsert":
        response = await handleBulkUpsert(requestId, body.data);
        break;
      case "delete":
        response = await handleDelete(requestId, body.data);
        break;
      case "meta":
        response = await handleMeta(requestId, body.data);
        break;
      case "resolveImages":
        response = await handleResolveImages(requestId, body.data);
        break;
      case "upsertCollection":
        response = await handleUpsertCollection(requestId, body.data);
        break;
      default:
        response = {
          ok: false,
          requestId,
          action: body.action,
          message: "Unknown action.",
          errors: ["Unknown action."],
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    response = {
      ok: false,
      requestId,
      action: body.action,
      message,
      errors: [message],
    };
  }

  if (response.ok && body.action !== "resolveImages") {
    await saveIdempotentResponse(requestId, response);
  }

  return response;
}

async function handleList(
  requestId: string,
  data: Record<string, unknown>,
): Promise<VeloProductsResponse> {
  const parsed = listDataSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      requestId,
      action: "list",
      message: "Invalid list parameters.",
      errors: ["Invalid list parameters."],
    };
  }

  const { search, draft, page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

  const filters = [];
  if (search.trim()) {
    const raw = search.trim();
    const q = `%${raw}%`;
    // Include product id so packing can resolve draft/archived items by id.
    filters.push(
      or(
        ilike(products.name, q),
        ilike(products.productCode, q),
        eq(products.id, raw)
      )
    );
  }
  if (draft === "draft") filters.push(eq(products.isDraft, true));
  if (draft === "published") filters.push(eq(products.isDraft, false));

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const [rows, countRow] = await Promise.all([
    db
      .select({
        id: products.id,
        productCode: products.productCode,
        name: products.name,
        price: products.price,
        stock: products.stock,
        isDraft: products.isDraft,
        collectionId: products.collectionId,
        collectionLabel: collections.label,
        createdAt: products.createdAt,
      })
      .from(products)
      .leftJoin(collections, eq(products.collectionId, collections.id))
      .where(whereClause)
      .orderBy(desc(products.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(whereClause),
  ]);
  const productIds = rows.map((row) => row.id);
  const [externalByProductId, sizeConfigs, imageByProductId] = await Promise.all([
    getExternalIdsForProductIds(productIds),
    getProductSizeConfigsByProductIds(productIds),
    resolveProductImageUrls(productIds),
  ]);

  return {
    ok: true,
    requestId,
    action: "list",
    products: rows.map((row) => ({
      productId: row.id,
      externalProductId: externalByProductId.get(row.id) ?? null,
      productCode: row.productCode,
      name: row.name,
      collectionId: row.collectionId,
      collectionName: row.collectionLabel,
      price: row.price,
      stock: row.stock,
      isDraft: row.isDraft,
      sizeConfig: sizeConfigs.get(row.id) ?? { enabled: false, options: [] },
      imageUrl: imageByProductId.get(row.id) ?? null,
      updatedAt: row.createdAt,
    })),
    page,
    pageSize,
    total: countRow[0]?.count ?? 0,
    hasMore: offset + rows.length < (countRow[0]?.count ?? 0),
  };
}

async function handleUpsert(
  requestId: string,
  data: Record<string, unknown>,
): Promise<VeloProductsResponse> {
  const parsed = upsertDataSchema.safeParse(data);
  if (!parsed.success) {
    const parseError = parsed as z.SafeParseError<
      z.infer<typeof upsertDataSchema>
    >;
    const msg = parseError.error.issues.map((i) => i.message).join("; ");
    return {
      ok: false,
      requestId,
      action: "upsert",
      message: msg || "Invalid product data.",
      errors: [msg || "Invalid product data."],
    };
  }

  const d = parsed.data;
  const result = await performUpsert(d);

  return {
    ok: true,
    requestId,
    action: "upsert",
    message: result.created ? "Product created." : "Product updated.",
    product: result.product,
  };
}

async function handleBulkUpsert(
  requestId: string,
  data: Record<string, unknown>,
): Promise<VeloProductsResponse> {
  const parsed = bulkDataSchema.safeParse(data);
  if (!parsed.success) {
    const parseError = parsed as z.SafeParseError<
      z.infer<typeof bulkDataSchema>
    >;
    const msg = parseError.error.issues.map((i) => i.message).join("; ");
    return {
      ok: false,
      requestId,
      action: "bulk_upsert",
      message: msg || "Invalid bulk data.",
      errors: [msg || "Invalid bulk data."],
    };
  }

  const d = parsed.data;
  const createdOrUpdated: Array<{
    index: number;
    externalProductId: string;
    created: boolean;
    product: {
      productId: string;
      productCode: string | null;
      slug: string;
      name: string;
      isDraft: boolean;
    };
  }> = [];
  const errors: string[] = [];

  for (let index = 0; index < d.items.length; index += 1) {
    const item = d.items[index];
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await performUpsert({
        productId: undefined,
        externalProductId: item.externalProductId,
        name: item.name?.trim() || `${d.shared.namePrefix} ${index + 1}`,
        description: d.shared.description,
        collectionId: d.shared.collectionId ?? null,
        tags: d.shared.tags,
        badge: d.shared.badge ?? null,
        rating: d.shared.rating,
        price: d.shared.price,
        stock: d.shared.stock,
        isDraft: d.shared.isDraft,
        featuredImageMediaId: item.featuredImageMediaId,
        imageBase64: item.imageBase64,
        imageFileName: item.imageFileName,
        sizeConfig: d.shared.sizeConfig,
      });
      createdOrUpdated.push({
        index,
        externalProductId: item.externalProductId,
        created: result.created,
        product: result.product,
      });
    } catch (error) {
      errors.push(
        `Item ${index + 1} (${item.externalProductId}): ${
          error instanceof Error ? error.message : "Bulk upsert failed."
        }`,
      );
    }
  }

  if (createdOrUpdated.length === 0) {
    return {
      ok: false,
      requestId,
      action: "bulk_upsert",
      message: "No products were upserted.",
      errors: errors.length > 0 ? errors : ["No valid bulk rows."],
      created: [],
      warnings: errors,
    };
  }

  return {
    ok: true,
    requestId,
    action: "bulk_upsert",
    message:
      errors.length > 0
        ? "Bulk upsert completed with warnings."
        : "Bulk upsert completed.",
    created: createdOrUpdated,
    createdCount: createdOrUpdated.filter((item) => item.created).length,
    updatedCount: createdOrUpdated.filter((item) => !item.created).length,
    warnings: errors,
    errors,
  };
}

async function handleDelete(
  requestId: string,
  data: Record<string, unknown>,
): Promise<VeloProductsResponse> {
  const parsed = deleteDataSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      requestId,
      action: "delete",
      message: "Invalid delete payload.",
      errors: ["productId is required."],
    };
  }

  const productId =
    parsed.data.productId ??
    (await findProductByExternalId(parsed.data.externalProductId ?? ""))?.id;
  if (!productId) {
    return {
      ok: false,
      requestId,
      action: "delete",
      message: "Product not found.",
      errors: ["Product not found."],
    };
  }

  const [existing] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!existing) {
    return {
      ok: false,
      requestId,
      action: "delete",
      message: "Product not found.",
      errors: ["Product not found."],
    };
  }

  const linked = await db
    .select({ productId: orderLines.productId })
    .from(orderLines)
    .where(eq(orderLines.productId, productId))
    .limit(1);

  if (linked.length > 0) {
    return {
      ok: false,
      requestId,
      action: "delete",
      message: "Product has order history and cannot be deleted.",
      errors: ["Product has order history and cannot be deleted."],
    };
  }

  await db.delete(products).where(eq(products.id, productId));
  if (parsed.data.externalProductId) {
    await db
      .delete(apiSettings)
      .where(
        eq(apiSettings.key, externalProductKey(parsed.data.externalProductId)),
      );
  }

  return {
    ok: true,
    requestId,
    action: "delete",
    message: "Product deleted.",
    productId,
  };
}

async function handleMeta(
  requestId: string,
  data: Record<string, unknown>,
): Promise<VeloProductsResponse> {
  const parsed = metaDataSchema.safeParse(data);
  if (!parsed.success || parsed.data.type !== "collections") {
    return {
      ok: false,
      requestId,
      action: "meta",
      message: "Invalid meta request.",
      errors: ["type must be collections."],
    };
  }

  const rows = await db
    .select({
      id: collections.id,
      label: collections.label,
      slug: collections.slug,
      description: collections.description,
      featuredImageId: collections.featuredImageId,
      mediaKey: medias.key,
    })
    .from(collections)
    .leftJoin(medias, eq(collections.featuredImageId, medias.id))
    .orderBy(asc(collections.label));

  return {
    ok: true,
    requestId,
    action: "meta",
    collections: rows.map((row) => ({
      id: row.id,
      label: row.label,
      slug: row.slug,
      description: row.description,
      featuredImageId: row.featuredImageId,
      imageUrl: row.mediaKey ? keytoUrl(row.mediaKey) : null,
    })),
    badges: ["new_product", "best_sale", "featured"],
    defaultSizes: DEFAULT_SIZES,
  };
}

async function handleUpsertCollection(
  requestId: string,
  data: Record<string, unknown>,
): Promise<VeloProductsResponse> {
  const parsed = upsertCollectionDataSchema.safeParse(data);
  if (!parsed.success) {
    const parseError = parsed as z.SafeParseError<
      z.infer<typeof upsertCollectionDataSchema>
    >;
    return {
      ok: false,
      requestId,
      action: "upsertCollection",
      message: "Invalid category payload.",
      errors: parseError.error.issues.map((issue) => issue.message),
    };
  }

  const name = parsed.data.name.trim();
  const description = parsed.data.description.trim();
  const existingId = parsed.data.id?.trim();

  let featuredImageId: string;
  try {
    if (existingId && !parsed.data.imageBase64 && !parsed.data.featuredImageMediaId) {
      const [existing] = await db
        .select({ featuredImageId: collections.featuredImageId })
        .from(collections)
        .where(eq(collections.id, existingId))
        .limit(1);
      if (!existing) {
        return {
          ok: false,
          requestId,
          action: "upsertCollection",
          message: "Category not found.",
          errors: ["Category not found."],
        };
      }
      featuredImageId = existing.featuredImageId;
    } else if (!parsed.data.featuredImageMediaId && !parsed.data.imageBase64) {
      return {
        ok: false,
        requestId,
        action: "upsertCollection",
        message: "Category image is required.",
        errors: ["Category image is required."],
      };
    } else {
      featuredImageId = await resolveMediaId(
        parsed.data.featuredImageMediaId,
        parsed.data.imageBase64,
        parsed.data.imageFileName || "category.jpg",
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Category image is required.";
    return {
      ok: false,
      requestId,
      action: "upsertCollection",
      message,
      errors: [message],
    };
  }

  if (existingId) {
    const [existing] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.id, existingId))
      .limit(1);
    if (!existing) {
      return {
        ok: false,
        requestId,
        action: "upsertCollection",
        message: "Category not found.",
        errors: ["Category not found."],
      };
    }

    const slug = await buildUniqueCollectionSlug(name, existingId);
    await db
      .update(collections)
      .set({
        slug,
        label: name,
        title: name,
        description,
        featuredImageId,
      })
      .where(eq(collections.id, existingId));
    await revalidateCollectionPages();

    const [media] = await db
      .select({ key: medias.key })
      .from(medias)
      .where(eq(medias.id, featuredImageId))
      .limit(1);

    return {
      ok: true,
      requestId,
      action: "upsertCollection",
      message: "Category updated.",
      collection: {
        id: existingId,
        label: name,
        slug,
        description,
        featuredImageId,
        imageUrl: media?.key ? keytoUrl(media.key) : null,
      },
    };
  }

  const slug = await buildUniqueCollectionSlug(name);
  const [created] = await db
    .insert(collections)
    .values({
      slug,
      label: name,
      title: name,
      description,
      featuredImageId,
    })
    .returning({ id: collections.id });

  await revalidateCollectionPages();

  const [media] = await db
    .select({ key: medias.key })
    .from(medias)
    .where(eq(medias.id, featuredImageId))
    .limit(1);

  return {
    ok: true,
    requestId,
    action: "upsertCollection",
    message: "Category created.",
    collection: {
      id: created.id,
      label: name,
      slug,
      description,
      featuredImageId,
      imageUrl: media?.key ? keytoUrl(media.key) : null,
    },
  };
}

/** Batch-resolve packing photos by shop product ids (draft + published). */
async function handleResolveImages(
  requestId: string,
  data: Record<string, unknown>,
): Promise<VeloProductsResponse> {
  const parsed = resolveImagesDataSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      requestId,
      action: "resolveImages",
      message: "Invalid resolveImages payload.",
      errors: ["productIds (1–100) is required."],
    };
  }

  const ids = [...new Set(parsed.data.productIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) {
    return {
      ok: true,
      requestId,
      action: "resolveImages",
      products: [],
    };
  }

  const [rows, imageByProductId] = await Promise.all([
    db
      .select({
        id: products.id,
        productCode: products.productCode,
        name: products.name,
      })
      .from(products)
      .where(inArray(products.id, ids)),
    resolveProductImageUrls(ids),
  ]);

  return {
    ok: true,
    requestId,
    action: "resolveImages",
    products: rows.map((row) => ({
      productId: row.id,
      productCode: row.productCode,
      name: row.name,
      collectionId: null,
      collectionName: null,
      price: "0",
      stock: null,
      isDraft: false,
      updatedAt: "",
      imageUrl: imageByProductId.get(row.id) ?? null,
    })),
  };
}
