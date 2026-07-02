import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
  DeliveryDiscountCandidate,
} from "../generated/api";

type MoadShippingDiscountEntry = {
  discount_cents?: unknown;
  value_type?: unknown;
  value?: unknown;
  calculated_at_checkout?: unknown;
  label?: unknown;
  promotion_name?: unknown;
};

type ManualShippingConfig = MoadShippingDiscountEntry & {
  schema_version?: unknown;
  discount_class?: unknown;
  discount_type?: unknown;
  target_type?: unknown;
  target_product_ids?: unknown;
  target_variant_ids?: unknown;
  min_requirement?: unknown;
  min_purchase_amount_cents?: unknown;
  min_quantity_of_items?: unknown;
};

type MoadDiscountPayload = {
  shipping_discounts?: unknown;
  line_discounts?: unknown;
  order_discounts?: unknown;
  total_discount_cents?: unknown;
};

const PAYLOAD_ATTRIBUTE_KEY = "moad_discount_payload";
const SIGNATURE_ATTRIBUTE_KEY = "moad_discount_signature";
const VERSION_ATTRIBUTE_KEY = "moad_discount_version";
const SUPPORTED_VERSION = "v1";

function debugLog(message: string, details?: unknown): void {
  if (typeof details === "undefined") {
    console.error(`[moad-discount-function][delivery] ${message}`);
    return;
  }

  try {
    console.error(
      `[moad-discount-function][delivery] ${message}: ${JSON.stringify(details)}`,
    );
  } catch (error) {
    console.error(
      `[moad-discount-function][delivery] ${message}: <unserializable ${String(
        error,
      )}>`,
    );
  }
}

function previewValue(value: string): string {
  if (!value) {
    return "";
  }
  return value.length > 250 ? `${value.slice(0, 250)}...(truncated)` : value;
}

function summarizePayload(
  payload: MoadDiscountPayload | null,
): Record<string, unknown> {
  return {
    shipping_discounts_count: Array.isArray(payload?.shipping_discounts)
      ? payload.shipping_discounts.length
      : null,
    line_discounts_count: Array.isArray(payload?.line_discounts)
      ? payload.line_discounts.length
      : null,
    order_discounts_count: Array.isArray(payload?.order_discounts)
      ? payload.order_discounts.length
      : null,
    total_discount_cents: payload?.total_discount_cents ?? null,
  };
}

function getAttributeValue(
  attribute: { value?: string | null } | null | undefined,
): string {
  return attribute?.value ?? "";
}

function parsePayload(rawPayload: string): MoadDiscountPayload | null {
  if (!rawPayload) {
    debugLog("No raw payload provided to parsePayload");
    return null;
  }

  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      debugLog("Parsed payload was not an object", {
        rawPayload: previewValue(rawPayload),
      });
      return null;
    }
    debugLog(
      "Payload parsed successfully",
      summarizePayload(parsed as MoadDiscountPayload),
    );
    return parsed as MoadDiscountPayload;
  } catch (error) {
    console.error(
      "[moad-discount-function] Failed to parse payload JSON",
      String(error),
    );
    debugLog("Payload parse failure details", {
      error: String(error),
      rawPayload: previewValue(rawPayload),
    });
    return null;
  }
}

function isSupportedVersion(rawVersion: string): boolean {
  if (!rawVersion) {
    // Missing version falls back to v1 for backwards compatibility.
    return true;
  }
  return rawVersion === SUPPORTED_VERSION;
}

function asValidCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) {
    return null;
  }
  return Math.round(value);
}

function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function amountToString(amount: number): string {
  return Math.max(0, amount).toFixed(2);
}

function getMessage(entry: MoadShippingDiscountEntry): string | undefined {
  if (typeof entry.label === "string" && entry.label.trim()) {
    return entry.label.trim();
  }
  if (typeof entry.promotion_name === "string" && entry.promotion_name.trim()) {
    return entry.promotion_name.trim();
  }
  return undefined;
}

function toShippingEntries(value: unknown): MoadShippingDiscountEntry[] {
  return Array.isArray(value) ? (value as MoadShippingDiscountEntry[]) : [];
}

function normalizeShopifyId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  const last = trimmed.includes("/") ? trimmed.split("/").pop() : trimmed;
  return (last ?? trimmed).toLowerCase();
}

function normalizeIdSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(
    value
      .map((item) => normalizeShopifyId(item))
      .filter((item): item is string => Boolean(item)),
  );
}

function lineSubtotalCents(
  line: DeliveryInput["cart"]["lines"][number],
): number {
  return Math.round(parseAmount(line.cost.subtotalAmount.amount) * 100);
}

function lineMatchesManualTarget(
  line: DeliveryInput["cart"]["lines"][number],
  config: ManualShippingConfig,
): boolean {
  const targetType =
    typeof config.target_type === "string" ? config.target_type : "all_products";

  if (!targetType || targetType === "all_products") {
    return true;
  }

  if (line.merchandise.__typename !== "ProductVariant") {
    return false;
  }

  if (targetType === "specific_products") {
    const productIds = normalizeIdSet(config.target_product_ids);
    if (!productIds.size) {
      return false;
    }
    const productId = normalizeShopifyId(line.merchandise.product.id);
    return productId !== null && productIds.has(productId);
  }

  if (targetType === "specific_variants") {
    const variantIds = normalizeIdSet(config.target_variant_ids);
    if (!variantIds.size) {
      return false;
    }
    const variantId = normalizeShopifyId(line.merchandise.id);
    return variantId !== null && variantIds.has(variantId);
  }

  debugLog("Manual shipping config ignored due to unsupported target type", {
    target_type: targetType,
  });
  return false;
}

function isManualShippingConfigEligible(
  input: DeliveryInput,
  config: ManualShippingConfig,
): boolean {
  const qualifyingLines = input.cart.lines.filter((line) =>
    lineMatchesManualTarget(line, config),
  );

  if (!qualifyingLines.length) {
    debugLog("Manual shipping config rejected because no cart lines qualify", {
      target_type: config.target_type ?? null,
      target_product_ids: config.target_product_ids ?? null,
      target_variant_ids: config.target_variant_ids ?? null,
    });
    return false;
  }

  const qualifyingSubtotalCents = qualifyingLines.reduce(
    (sum, line) => sum + lineSubtotalCents(line),
    0,
  );
  const qualifyingQuantity = qualifyingLines.reduce(
    (sum, line) => sum + line.quantity,
    0,
  );
  const minRequirement =
    typeof config.min_requirement === "string" ? config.min_requirement : "none";

  if (
    minRequirement === "min_purchase_amount" &&
    typeof config.min_purchase_amount_cents === "number" &&
    qualifyingSubtotalCents < config.min_purchase_amount_cents
  ) {
    debugLog("Manual shipping config rejected by minimum purchase amount", {
      qualifying_subtotal_cents: qualifyingSubtotalCents,
      min_purchase_amount_cents: config.min_purchase_amount_cents,
    });
    return false;
  }

  if (
    minRequirement === "min_quantity" &&
    typeof config.min_quantity_of_items === "number" &&
    qualifyingQuantity < config.min_quantity_of_items
  ) {
    debugLog("Manual shipping config rejected by minimum quantity", {
      qualifying_quantity: qualifyingQuantity,
      min_quantity_of_items: config.min_quantity_of_items,
    });
    return false;
  }

  return true;
}

function getManualShippingEntry(
  input: DeliveryInput,
  config: unknown,
  triggeringDiscountCode?: string | null,
): MoadShippingDiscountEntry | null {
  if (!triggeringDiscountCode) {
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }

  const manualConfig = config as ManualShippingConfig;
  if (manualConfig.schema_version !== "v1") {
    debugLog("Manual shipping config ignored due to unsupported schema", {
      schema_version: manualConfig.schema_version ?? null,
    });
    return null;
  }
  if (
    manualConfig.discount_class !== "shipping" ||
    manualConfig.discount_type !== "free_shipping"
  ) {
    debugLog("Manual shipping config ignored due to non-shipping discount type", {
      discount_class: manualConfig.discount_class ?? null,
      discount_type: manualConfig.discount_type ?? null,
    });
    return null;
  }
  if (!isManualShippingConfigEligible(input, manualConfig)) {
    return null;
  }

  return {
    discount_cents: manualConfig.discount_cents,
    value_type: manualConfig.value_type,
    value: manualConfig.value,
    calculated_at_checkout: true,
    label: manualConfig.label,
    promotion_name: manualConfig.promotion_name,
  };
}

function addShippingCandidatesForEntry(
  input: DeliveryInput,
  entry: MoadShippingDiscountEntry,
  candidates: DeliveryDiscountCandidate[],
): void {
  const checkoutValue = asPositiveNumber(entry.value);
  const isCheckoutCalculated = entry.calculated_at_checkout === true;

  if (
    isCheckoutCalculated &&
    entry.value_type === "percentage" &&
    checkoutValue !== null
  ) {
    debugLog("Creating checkout-calculated percentage shipping candidates", {
      value_type: entry.value_type,
      value: checkoutValue,
    });

    for (const deliveryGroup of input.cart.deliveryGroups) {
      for (const deliveryOption of deliveryGroup.deliveryOptions) {
        candidates.push({
          ...(getMessage(entry) ? { message: getMessage(entry) } : {}),
          targets: [{ deliveryOption: { handle: deliveryOption.handle } }],
          value: {
            percentage: {
              value: amountToString(Math.min(checkoutValue, 100)),
            },
          },
        });
      }
    }
    return;
  }

  if (
    isCheckoutCalculated &&
    entry.value_type === "fixed_amount" &&
    checkoutValue !== null
  ) {
    const fixedAmount = checkoutValue / 100;
    debugLog("Creating checkout-calculated fixed shipping candidates", {
      value_type: entry.value_type,
      value: checkoutValue,
      fixed_amount: fixedAmount,
    });

    for (const deliveryGroup of input.cart.deliveryGroups) {
      for (const deliveryOption of deliveryGroup.deliveryOptions) {
        const deliveryOptionCost = parseAmount(deliveryOption.cost.amount);
        const cappedAmount =
          deliveryOptionCost > 0
            ? Math.min(fixedAmount, deliveryOptionCost)
            : fixedAmount;

        candidates.push({
          ...(getMessage(entry) ? { message: getMessage(entry) } : {}),
          targets: [{ deliveryOption: { handle: deliveryOption.handle } }],
          value: {
            fixedAmount: {
              amount: amountToString(cappedAmount),
            },
          },
        });
      }
    }
    return;
  }

  const cents = asValidCents(entry.discount_cents);
  if (!cents) {
    debugLog("Shipping discount skipped due to invalid cents", {
      discount_cents: entry.discount_cents ?? null,
      value_type: entry.value_type ?? null,
      value: entry.value ?? null,
      calculated_at_checkout: entry.calculated_at_checkout ?? null,
      label: entry.label ?? null,
      promotion_name: entry.promotion_name ?? null,
    });
    return;
  }

  debugLog("Creating shipping discount candidates for delivery options", {
    delivery_option_handles: input.cart.deliveryGroups.flatMap((deliveryGroup) =>
      deliveryGroup.deliveryOptions.map((deliveryOption) => deliveryOption.handle),
    ),
    discount_cents: entry.discount_cents ?? null,
    parsed_cents: cents,
  });

  for (const deliveryGroup of input.cart.deliveryGroups) {
    for (const deliveryOption of deliveryGroup.deliveryOptions) {
      candidates.push({
        ...(getMessage(entry) ? { message: getMessage(entry) } : {}),
        targets: [{ deliveryOption: { handle: deliveryOption.handle } }],
        value: {
          fixedAmount: {
            amount: centsToAmount(cents),
          },
        },
      });
    }
  }
}

export function cartDeliveryOptionsDiscountsGenerateRun(
  input: DeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  debugLog(
    "Function invoked with discount classes",
    input.discount.discountClasses,
  );
  debugLog("Raw cart attribute presence", {
    payload_attribute_present: Boolean(input.cart.attribute?.value),
    signature_attribute_present: Boolean(input.cart.signatureAttribute?.value),
    version_attribute_present: Boolean(input.cart.versionAttribute?.value),
    cart_line_count: input.cart.lines.length,
    delivery_group_count: input.cart.deliveryGroups.length,
    delivery_option_count: input.cart.deliveryGroups.reduce(
      (count, deliveryGroup) => count + deliveryGroup.deliveryOptions.length,
      0,
    ),
    triggering_discount_code: input.triggeringDiscountCode ?? null,
    manual_shipping_config_present: Boolean(input.discount.manualShippingConfig?.jsonValue),
  });

  const hasShippingDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Shipping,
  );

  if (!hasShippingDiscountClass) {
    debugLog(
      "Returning empty operations because no shipping discount class was provided",
    );
    return { operations: [] };
  }

  const rawPayload = getAttributeValue(input.cart.attribute);
  const rawSignature = getAttributeValue(input.cart.signatureAttribute);
  const rawVersion = getAttributeValue(input.cart.versionAttribute);
  debugLog("Extracted raw cart attributes", {
    payload_key: PAYLOAD_ATTRIBUTE_KEY,
    payload_preview: previewValue(rawPayload),
    signature_key: SIGNATURE_ATTRIBUTE_KEY,
    signature_preview: previewValue(rawSignature),
    version_key: VERSION_ATTRIBUTE_KEY,
    version: rawVersion,
  });

  if (!isSupportedVersion(rawVersion)) {
    console.error(
      `[moad-discount-function] Unsupported payload version: ${rawVersion}`,
    );
    debugLog(
      "Returning empty operations because payload version is unsupported",
      {
        version: rawVersion,
      },
    );
    return { operations: [] };
  }

  const payload = parsePayload(rawPayload);
  if (!payload) {
    debugLog(
      "Returning empty operations because payload is missing or invalid",
      {
        payload_preview: previewValue(rawPayload),
        signature_preview: previewValue(rawSignature),
        version: rawVersion,
      },
    );
    return { operations: [] };
  }

  debugLog(
    "Parsed payload summary in delivery run function",
    summarizePayload(payload),
  );

  // Line and order discounts are unsupported in this target and are handled by
  // `cart.lines.discounts.generate.run`. We keep processing shipping entries only.
  if (
    Array.isArray(payload.line_discounts) ||
    Array.isArray(payload.order_discounts)
  ) {
    console.error(
      "[moad-discount-function] Non-shipping discounts present; ignored in delivery target",
    );
    debugLog("Detected non-shipping discounts in delivery target", {
      line_discounts_count: Array.isArray(payload.line_discounts)
        ? payload.line_discounts.length
        : 0,
      order_discounts_count: Array.isArray(payload.order_discounts)
        ? payload.order_discounts.length
        : 0,
    });
  }

  const candidates: DeliveryDiscountCandidate[] = [];

  for (const entry of toShippingEntries(payload.shipping_discounts)) {
    addShippingCandidatesForEntry(input, entry, candidates);
  }

  const manualShippingEntry = getManualShippingEntry(
    input,
    input.discount.manualShippingConfig?.jsonValue,
    input.triggeringDiscountCode,
  );
  if (manualShippingEntry) {
    debugLog("Manual shipping code config accepted", {
      triggering_discount_code: input.triggeringDiscountCode,
      value_type: manualShippingEntry.value_type ?? null,
      value: manualShippingEntry.value ?? null,
    });
    addShippingCandidatesForEntry(input, manualShippingEntry, candidates);
  }

  if (!candidates.length) {
    debugLog("No valid shipping discount candidates were produced", {
      delivery_group_ids: input.cart.deliveryGroups.map(
        (deliveryGroup) => deliveryGroup.id,
      ),
      delivery_option_handles: input.cart.deliveryGroups.flatMap(
        (deliveryGroup) =>
          deliveryGroup.deliveryOptions.map(
            (deliveryOption) => deliveryOption.handle,
          ),
      ),
      shipping_discounts_count: Array.isArray(payload.shipping_discounts)
        ? payload.shipping_discounts.length
        : 0,
    });
    return { operations: [] };
  }

  debugLog("Final delivery candidates before return", candidates);
  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates,
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
