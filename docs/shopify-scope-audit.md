# Shopify Scope Audit - MOAD

Date: 2026-07-14

This audit covers the staging Shopify app config used by `moad-discount-app` and the connected MOAD backend/frontend flows. The retained scopes are the minimum set found in active MOAD code paths for promotion setup, audience search, Shopify Function discount registration, cart attribute syncing, and cart webhook registration.

## Retained scopes

| Scope | Why MOAD needs it | Code path |
| --- | --- | --- |
| `read_products` | Promotion targeting uses Shopify product, variant, and collection selection through the embedded app resource picker. | `moad-frontend/app/lib/resourcePicker.ts` |
| `read_customers` | Audience targeting searches customers and segments from the backend for customer/segment-based promotion rules. | `moad-backend/src/services/shopify-admin.ts` |
| `read_discounts` | The backend checks existing automatic/code app discounts before creating or updating MOAD function discounts. | `moad-backend/src/services/create-shopify-function-discount.ts` |
| `write_discounts` | The backend creates and updates automatic and manual-code app discounts that invoke the Shopify Function. | `moad-backend/src/services/create-shopify-function-discount.ts` |
| `read_orders` | Shopify requires this scope for cart webhook topics used by MOAD cart sync. | `moad-backend/src/services/register-cart-webhooks.ts` |
| `unauthenticated_write_checkouts` | The backend creates a Storefront token and updates cart attributes so checkout receives the signed MOAD discount payload. | `moad-backend/src/services/update-cart-attributes.ts` |

## Removed scopes

| Removed scope family | Reason removed |
| --- | --- |
| `write_products` | Only the generated Shopify template/demo route creates products; MOAD promotion flows do not write products. |
| `read_price_rules`, `write_price_rules` | MOAD uses Shopify Function app discounts, not legacy price rules. |
| `write_customers` | MOAD reads customers for audience targeting but does not mutate customers. |
| `read_customer_events`, `read_customer_merge`, `read_customer_data_erasure`, `write_customer_data_erasure` | No active Admin API calls use these scopes. Privacy webhook receivers remain available under `/webhooks/*`. |
| `read_discounts_allocator_functions`, `write_discounts_allocator_functions` | No active allocator-function Admin API calls were found. |
| `customer_*` scopes | Customer Account API is not used by the current embedded app, backend, function, or storefront cart token flow. |
| `unauthenticated_read_customers`, `unauthenticated_write_customers`, `unauthenticated_read_customer_tags` | Storefront Customer API access is not used; the storefront flow only writes cart attributes. |

## Review notes

- Scope changes require a new Shopify app version and app reinstall/reconsent before they are effective for a store.
- The active MOAD discount runtime depends on the theme app extension asset loading `cart-token-block.js` and writing `moad_discount_payload` to cart attributes.
- If customer creation, product creation, price rules, or Customer Account API features are added later, those features should request scopes in the same change that introduces the API call.

## Shopify references

- Access scopes: https://shopify.dev/docs/api/usage/access-scopes
- App configuration: https://shopify.dev/docs/apps/tools/cli/configuration
- `discountAutomaticAppCreate`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/discountAutomaticAppCreate
- `discountCodeAppCreate`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/discountCodeAppCreate
- `discountCodeAppUpdate`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/discountCodeAppUpdate
- `storefrontAccessTokenCreate`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/storefrontAccessTokenCreate
