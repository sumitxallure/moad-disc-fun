# Release Smoke Tests

Run this after releasing a Shopify app version to catch bad app URLs, dead tunnels, missing theme-extension assets, and stale backend URLs before QA starts testing.

```bash
npm run smoke:release
```

## Useful Environment Variables

```bash
SMOKE_CONFIG=shopify.app.moad-duplin-staging.toml
SMOKE_EXPECTED_APP_URL=https://moad.allurecommerce.com
SMOKE_EXPECTED_REDIRECT_URL=https://moad-api.allurecommerce.com/auth/callback
SMOKE_BACKEND_HEALTH_URL=https://moad-api.allurecommerce.com/health
SMOKE_EXPECTED_CART_MAPPING_URL=https://moad-api.allurecommerce.com/v1/cart-mapping
SMOKE_STOREFRONT_URL=https://duplin-staging.myshopify.com/
SMOKE_STOREFRONT_PASSWORD=skauch
```

If storefront discovery is blocked or you already know the released CDN URL, pass it directly:

```bash
SMOKE_CART_TOKEN_ASSET_URL=https://cdn.shopify.com/extensions/.../assets/cart-token-block.js
npm run smoke:release
```

## What It Checks

- `shopify.app.*.toml` has an app URL and redirect callback.
- Optional expected app URL and redirect callback match the config.
- Optional backend `/health` returns `200`.
- Local source `cart-token-block.js` contains the expected cart-mapping backend URL.
- Storefront page includes the released `cart-token-block.js`, or a direct CDN asset URL is provided.
- Released `cart-token-block.js` returns `200` and contains the expected cart-mapping backend URL.

This is intentionally not a full checkout automation. Checkout can be flaky because of Shopify bot protection and address/payment state. Keep checkout verification as manual QA until these release checks are stable.
