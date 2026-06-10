import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

type MoadDiscountEntry = {
  discount_cents?: unknown;
  line_id?: unknown;
  label?: unknown;
  promotion_name?: unknown;
};

type MoadDiscountPayload = {
  evaluation_id?: unknown;
  evaluation_version?: unknown;
  line_discounts?: unknown;
  order_discounts?: unknown;
  shipping_discounts?: unknown;
  total_discount_cents?: unknown;
};

const PAYLOAD_ATTRIBUTE_KEY = 'moad_discount_payload';
const SIGNATURE_ATTRIBUTE_KEY = 'moad_discount_signature';
const VERSION_ATTRIBUTE_KEY = 'moad_discount_version';
const SUPPORTED_VERSION = 'v1';

function debugLog(message: string, details?: unknown): void {
  if (typeof details === 'undefined') {
    console.error(`[moad-discount-function][cart-lines] ${message}`);
    return;
  }

  try {
    console.error(
      `[moad-discount-function][cart-lines] ${message}: ${JSON.stringify(details)}`,
    );
  } catch (error) {
    console.error(
      `[moad-discount-function][cart-lines] ${message}: <unserializable ${String(
        error,
      )}>`,
    );
  }
}

function previewValue(value: string): string {
  if (!value) {
    return '';
  }
  return value.length > 250 ? `${value.slice(0, 250)}...(truncated)` : value;
}

function summarizePayload(payload: MoadDiscountPayload | null): Record<string, unknown> {
  return {
    evaluation_id: payload?.evaluation_id ?? null,
    evaluation_version: payload?.evaluation_version ?? null,
    line_discounts_count: Array.isArray(payload?.line_discounts)
      ? payload.line_discounts.length
      : null,
    order_discounts_count: Array.isArray(payload?.order_discounts)
      ? payload.order_discounts.length
      : null,
    shipping_discounts_count: Array.isArray(payload?.shipping_discounts)
      ? payload.shipping_discounts.length
      : null,
    total_discount_cents: payload?.total_discount_cents ?? null,
  };
}

function getAttributeValue(
  attribute: {value?: string | null} | null | undefined,
): string {
  return attribute?.value ?? '';
}

function parsePayload(rawPayload: string): MoadDiscountPayload | null {
  if (!rawPayload) {
    debugLog('No raw payload provided to parsePayload');
    return null;
  }

  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      debugLog('Parsed payload was not an object', {rawPayload: previewValue(rawPayload)});
      return null;
    }
    debugLog('Payload parsed successfully', summarizePayload(parsed as MoadDiscountPayload));
    return parsed as MoadDiscountPayload;
  } catch (error) {
    console.error(
      '[moad-discount-function] Failed to parse payload JSON',
      String(error),
    );
    debugLog('Payload parse failure details', {
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
  if (typeof value !== 'number' || !Number.isFinite(value)) {
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

function getMessage(entry: MoadDiscountEntry): string | undefined {
  if (typeof entry.label === 'string' && entry.label.trim()) {
    return entry.label.trim();
  }
  if (typeof entry.promotion_name === 'string' && entry.promotion_name.trim()) {
    return entry.promotion_name.trim();
  }
  return undefined;
}

function toDiscountEntries(value: unknown): MoadDiscountEntry[] {
  return Array.isArray(value) ? (value as MoadDiscountEntry[]) : [];
}

function mapLineDiscounts(
  input: CartInput,
  payload: MoadDiscountPayload,
): CartLinesDiscountsGenerateRunResult['operations'] {
  const lineDiscounts = toDiscountEntries(payload.line_discounts);
  if (!lineDiscounts.length) {
    debugLog('No line discounts found in payload');
    return [];
  }

  const inputLineIds = input.cart.lines.map((line) => line.id);
  const lineIds = new Set(inputLineIds);
  debugLog('Input cart line ids available for targeting', inputLineIds);

  const candidates = lineDiscounts
    .map((entry) => {
      const hasValidLineId = typeof entry.line_id === 'string';
      const matchesInputLine = hasValidLineId && lineIds.has(entry.line_id);
      const cents = asValidCents(entry.discount_cents);

      debugLog('Evaluating line discount entry', {
        line_id: entry.line_id ?? null,
        discount_cents: entry.discount_cents ?? null,
        parsed_cents: cents,
        has_valid_line_id: hasValidLineId,
        matches_input_line: matchesInputLine,
        available_input_line_ids: inputLineIds,
      });

      if (!matchesInputLine) {
        debugLog('Line discount skipped due to line ID mismatch', {
          payload_line_id: entry.line_id ?? null,
          available_input_line_ids: inputLineIds,
        });
        return null;
      }

      if (!cents) {
        debugLog('Line discount skipped due to invalid cents', {
          line_id: entry.line_id,
          discount_cents: entry.discount_cents ?? null,
        });
        return null;
      }

      return {
        ...(getMessage(entry) ? {message: getMessage(entry)} : {}),
        targets: [{cartLine: {id: entry.line_id}}],
        value: {
          fixedAmount: {
            amount: centsToAmount(cents),
            appliesToEachItem: false,
          },
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  if (!candidates.length) {
    debugLog('No valid line discount candidates were produced', {
      input_line_ids: inputLineIds,
      payload_line_ids: lineDiscounts.map((entry) => entry.line_id ?? null),
    });
    return [];
  }

  debugLog('Line discount candidates generated', candidates);
  return [
    {
      productDiscountsAdd: {
        candidates,
        selectionStrategy: ProductDiscountSelectionStrategy.All,
      },
    },
  ];
}

function mapOrderDiscounts(
  payload: MoadDiscountPayload,
): CartLinesDiscountsGenerateRunResult['operations'] {
  const orderDiscounts = toDiscountEntries(payload.order_discounts);
  if (!orderDiscounts.length) {
    debugLog('No order discounts found in payload');
    return [];
  }

  const candidates = orderDiscounts
    .map((entry) => {
      const cents = asValidCents(entry.discount_cents);
      if (!cents) {
        debugLog('Order discount skipped due to invalid cents', {
          discount_cents: entry.discount_cents ?? null,
          label: entry.label ?? null,
          promotion_name: entry.promotion_name ?? null,
        });
        return null;
      }

      return {
        ...(getMessage(entry) ? {message: getMessage(entry)} : {}),
        targets: [{orderSubtotal: {excludedCartLineIds: []}}],
        value: {
          fixedAmount: {
            amount: centsToAmount(cents),
          },
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  if (!candidates.length) {
    debugLog('No valid order discount candidates were produced');
    return [];
  }

  debugLog('Order discount candidates generated', candidates);
  return [
    {
      orderDiscountsAdd: {
        candidates,
        selectionStrategy: OrderDiscountSelectionStrategy.Maximum,
      },
    },
  ];
}

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  debugLog('Function invoked with discount classes', input.discount.discountClasses);
  debugLog('Raw cart attribute presence', {
    payload_attribute_present: Boolean(input.cart.attribute?.value),
    signature_attribute_present: Boolean(input.cart.signatureAttribute?.value),
    version_attribute_present: Boolean(input.cart.versionAttribute?.value),
    cart_line_count: input.cart.lines.length,
  });

  const hasProductClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );
  const hasOrderClass = input.discount.discountClasses.includes(DiscountClass.Order);

  if (!hasProductClass && !hasOrderClass) {
    debugLog('Returning empty operations because no product/order discount classes were provided');
    return {operations: []};
  }

  const rawPayload = getAttributeValue(input.cart.attribute);
  const rawSignature = getAttributeValue(input.cart.signatureAttribute);
  const rawVersion = getAttributeValue(input.cart.versionAttribute);
  debugLog('Extracted raw cart attributes', {
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
    debugLog('Returning empty operations because payload version is unsupported', {
      version: rawVersion,
    });
    return {operations: []};
  }

  const payload = parsePayload(rawPayload);
  if (!payload) {
    console.error(
      `[moad-discount-function] Missing or invalid ${PAYLOAD_ATTRIBUTE_KEY}`,
    );
    debugLog('Returning empty operations because payload is missing or invalid', {
      payload_preview: previewValue(rawPayload),
      signature_preview: previewValue(rawSignature),
      version: rawVersion,
    });
    return {operations: []};
  }

  debugLog('Parsed payload summary in main run function', summarizePayload(payload));

  if (
    !Array.isArray(payload.line_discounts) &&
    !Array.isArray(payload.order_discounts) &&
    !Array.isArray(payload.shipping_discounts)
  ) {
    debugLog('Returning empty operations because payload contains no recognized discount arrays', {
      summary: summarizePayload(payload),
    });
    return {operations: []};
  }

  const operations: CartLinesDiscountsGenerateRunResult['operations'] = [];

  if (hasOrderClass) {
    operations.push(...mapOrderDiscounts(payload));
  }

  if (hasProductClass) {
    operations.push(...mapLineDiscounts(input, payload));
  }

  // Shipping discounts are intentionally ignored in this target.
  // They are applied in the `cart.delivery-options.discounts.generate.run` target.
  if (Array.isArray(payload.shipping_discounts) && payload.shipping_discounts.length) {
    console.error(
      '[moad-discount-function] Shipping discounts present; ignored in cart lines target',
    );
    debugLog('Shipping discounts detected in cart lines target', {
      shipping_discounts_count: payload.shipping_discounts.length,
    });
  }

  debugLog('Final operations before return', operations);
  debugLog('Returning operations result', {operation_count: operations.length});
  return {operations};
}