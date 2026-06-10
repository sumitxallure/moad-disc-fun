import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from "../generated/api";

type MoadShippingDiscountEntry = {
  discount_cents?: unknown;
  label?: unknown;
  promotion_name?: unknown;
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

function summarizePayload(payload: MoadDiscountPayload | null): Record<string, unknown> {
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
    debugLog("Payload parsed successfully", summarizePayload(parsed as MoadDiscountPayload));
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

function getMessage(entry: MoadShippingDiscountEntry): string | undefined {
  if (typeof entry.label === "string" && entry.label.trim()) {
    return entry.label.trim();
  }
  if (
    typeof entry.promotion_name === "string" &&
    entry.promotion_name.trim()
  ) {
    return entry.promotion_name.trim();
  }
  return undefined;
}

function toShippingEntries(value: unknown): MoadShippingDiscountEntry[] {
  return Array.isArray(value) ? (value as MoadShippingDiscountEntry[]) : [];
}

export function cartDeliveryOptionsDiscountsGenerateRun(
  input: DeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  debugLog("Function invoked with discount classes", input.discount.discountClasses);
  debugLog("Raw cart attribute presence", {
    payload_attribute_present: Boolean(input.cart.attribute?.value),
    signature_attribute_present: Boolean(input.cart.signatureAttribute?.value),
    version_attribute_present: Boolean(input.cart.versionAttribute?.value),
    delivery_group_count: input.cart.deliveryGroups.length,
  });

  const hasShippingDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Shipping,
  );

  if (!hasShippingDiscountClass) {
    debugLog("Returning empty operations because no shipping discount class was provided");
    return {operations: []};
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
    debugLog("Returning empty operations because payload version is unsupported", {
      version: rawVersion,
    });
    return {operations: []};
  }

  const payload = parsePayload(rawPayload);
  if (!payload) {
    debugLog("Returning empty operations because payload is missing or invalid", {
      payload_preview: previewValue(rawPayload),
      signature_preview: previewValue(rawSignature),
      version: rawVersion,
    });
    return {operations: []};
  }

  debugLog("Parsed payload summary in delivery run function", summarizePayload(payload));

  // Line and order discounts are unsupported in this target and are handled by
  // `cart.lines.discounts.generate.run`. We keep processing shipping entries only.
  if (Array.isArray(payload.line_discounts) || Array.isArray(payload.order_discounts)) {
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

  const candidates = toShippingEntries(payload.shipping_discounts)
    .flatMap((entry) => {
      const cents = asValidCents(entry.discount_cents);
      if (!cents) {
        debugLog("Shipping discount skipped due to invalid cents", {
          discount_cents: entry.discount_cents ?? null,
          label: entry.label ?? null,
          promotion_name: entry.promotion_name ?? null,
        });
        return [];
      }

      debugLog("Creating shipping discount candidates for delivery groups", {
        delivery_group_ids: input.cart.deliveryGroups.map((deliveryGroup) => deliveryGroup.id),
        discount_cents: entry.discount_cents ?? null,
        parsed_cents: cents,
      });
      return input.cart.deliveryGroups.map((deliveryGroup) => ({
        ...(getMessage(entry) ? {message: getMessage(entry)} : {}),
        targets: [{deliveryGroup: {id: deliveryGroup.id}}],
        value: {
          fixedAmount: {
            amount: centsToAmount(cents),
          },
        },
      }));
    });

  if (!candidates.length) {
    debugLog("No valid shipping discount candidates were produced", {
      delivery_group_ids: input.cart.deliveryGroups.map((deliveryGroup) => deliveryGroup.id),
      shipping_discounts_count: Array.isArray(payload.shipping_discounts)
        ? payload.shipping_discounts.length
        : 0,
    });
    return {operations: []};
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