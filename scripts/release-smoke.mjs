import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_CONFIG = 'shopify.app.moad-duplin-staging.toml';
const DEFAULT_SOURCE_ASSET = 'extensions/moad-cart-token-block/assets/cart-token-block.js';
const DEFAULT_EXPECTED_CART_MAPPING_URL = 'https://moad-api.allurecommerce.com/v1/cart-mapping';

function getArg(name) {
  const prefix = `--${name}=`;
  const exactIndex = process.argv.indexOf(`--${name}`);
  if (exactIndex !== -1) return process.argv[exactIndex + 1] ?? '';
  const pair = process.argv.find((arg) => arg.startsWith(prefix));
  return pair ? pair.slice(prefix.length) : '';
}

function option(name, envName, fallback = '') {
  return getArg(name) || process.env[envName] || fallback;
}

function normalizeUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

function pass(name, detail = '') {
  return { ok: true, name, detail };
}

function fail(name, detail) {
  return { ok: false, name, detail };
}

async function readTextFile(filePath) {
  return fs.readFile(filePath, 'utf8');
}

function parseAppConfig(toml) {
  const applicationUrl = toml.match(/^\s*application_url\s*=\s*"([^"]+)"/m)?.[1] ?? '';
  const redirectBlock = toml.match(/\[auth\][\s\S]*?redirect_urls\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? '';
  const redirectUrls = [...redirectBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return { applicationUrl, redirectUrls };
}

async function checkAppConfig(configPath, expectedAppUrl, expectedRedirectUrl) {
  const toml = await readTextFile(configPath);
  const config = parseAppConfig(toml);
  const checks = [];

  checks.push(config.applicationUrl
    ? pass('app config has application_url', config.applicationUrl)
    : fail('app config has application_url', `Missing application_url in ${configPath}`));

  checks.push(config.redirectUrls.length > 0
    ? pass('app config has redirect_urls', config.redirectUrls.join(', '))
    : fail('app config has redirect_urls', `Missing [auth].redirect_urls in ${configPath}`));

  if (expectedAppUrl) {
    checks.push(
      normalizeUrl(config.applicationUrl) === normalizeUrl(expectedAppUrl)
        ? pass('application_url matches expected', expectedAppUrl)
        : fail('application_url matches expected', `Expected ${expectedAppUrl}, got ${config.applicationUrl || '<missing>'}`)
    );
  }

  if (expectedRedirectUrl) {
    checks.push(
      config.redirectUrls.map(normalizeUrl).includes(normalizeUrl(expectedRedirectUrl))
        ? pass('redirect_urls contains expected callback', expectedRedirectUrl)
        : fail('redirect_urls contains expected callback', `Expected ${expectedRedirectUrl}, got ${config.redirectUrls.join(', ') || '<none>'}`)
    );
  }

  return checks;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'user-agent': 'MOAD release smoke test',
      ...options.headers,
    },
  });
  const text = await response.text();
  return { response, text };
}

async function checkBackendHealth(healthUrl) {
  if (!healthUrl) return pass('backend health skipped', 'Set SMOKE_BACKEND_HEALTH_URL to enable');

  try {
    const { response, text } = await fetchText(healthUrl, {
      headers: { 'ngrok-skip-browser-warning': '1' },
    });
    if (!response.ok) return fail('backend health returns 200', `${healthUrl} returned ${response.status}: ${text.slice(0, 160)}`);

    return pass('backend health returns 200', healthUrl);
  } catch (error) {
    return fail('backend health returns 200', `${healthUrl} failed: ${error.message}`);
  }
}

async function checkSourceAsset(sourceAssetPath, expectedCartMappingUrl) {
  try {
    const asset = await readTextFile(sourceAssetPath);
    if (!asset.includes(expectedCartMappingUrl)) {
      return fail('source cart-token-block.js contains backend URL', `Expected ${expectedCartMappingUrl} in ${sourceAssetPath}`);
    }

    return pass('source cart-token-block.js contains backend URL', expectedCartMappingUrl);
  } catch (error) {
    return fail('source cart-token-block.js contains backend URL', `${sourceAssetPath} failed: ${error.message}`);
  }
}

function getCookieHeader(setCookieValues) {
  return setCookieValues
    .map((value) => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
}

function getSetCookie(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const value = response.headers.get('set-cookie');
  return value ? [value] : [];
}

async function fetchStorefrontHtml(storefrontUrl, storefrontPassword) {
  const initial = await fetchText(storefrontUrl);
  let cookieHeader = getCookieHeader(getSetCookie(initial.response));

  if (!storefrontPassword || !/name=["']password["']|\/password|storefront_password/i.test(initial.text)) {
    return { html: initial.text, finalUrl: initial.response.url };
  }

  const passwordUrl = new URL('/password', storefrontUrl);
  const body = new URLSearchParams();
  body.set('form_type', 'storefront_password');
  body.set('utf8', '✓');
  body.set('password', storefrontPassword);

  const passwordResponse = await fetch(passwordUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'MOAD release smoke test',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body,
  });

  cookieHeader = [cookieHeader, getCookieHeader(getSetCookie(passwordResponse))]
    .filter(Boolean)
    .join('; ');

  const unlocked = await fetchText(storefrontUrl, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });

  return { html: unlocked.text, finalUrl: unlocked.response.url };
}

function findCartTokenAssetUrl(html, baseUrl) {
  const scriptMatches = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']*cart-token-block\.js[^"']*)["'][^>]*>/gi)];
  const src = scriptMatches[0]?.[1];
  if (!src) return null;
  return new URL(src, baseUrl).toString();
}

async function discoverAssetFromStorefront(storefrontUrl, storefrontPassword) {
  if (!storefrontUrl) return { check: pass('storefront asset discovery skipped', 'Set SMOKE_STOREFRONT_URL to enable'), assetUrl: '' };

  try {
    const { html, finalUrl } = await fetchStorefrontHtml(storefrontUrl, storefrontPassword);
    const assetUrl = findCartTokenAssetUrl(html, finalUrl);
    if (!assetUrl) {
      return {
        check: fail('storefront includes cart-token-block.js', `Could not find cart-token-block.js in ${finalUrl}`),
        assetUrl: '',
      };
    }

    return {
      check: pass('storefront includes cart-token-block.js', assetUrl),
      assetUrl,
    };
  } catch (error) {
    return {
      check: fail('storefront includes cart-token-block.js', `${storefrontUrl} failed: ${error.message}`),
      assetUrl: '',
    };
  }
}

async function checkReleasedAsset(assetUrl, expectedCartMappingUrl) {
  if (!assetUrl) return pass('released cart-token-block.js skipped', 'Set SMOKE_CART_TOKEN_ASSET_URL or SMOKE_STOREFRONT_URL to enable');

  try {
    const { response, text } = await fetchText(assetUrl);
    if (!response.ok) return fail('released cart-token-block.js returns 200', `${assetUrl} returned ${response.status}`);
    if (!text.includes(expectedCartMappingUrl)) {
      return fail('released cart-token-block.js contains backend URL', `Expected ${expectedCartMappingUrl} in ${assetUrl}`);
    }

    return pass('released cart-token-block.js contains backend URL', assetUrl);
  } catch (error) {
    return fail('released cart-token-block.js contains backend URL', `${assetUrl} failed: ${error.message}`);
  }
}

function printResults(results) {
  for (const result of results) {
    const icon = result.ok ? 'PASS' : 'FAIL';
    const suffix = result.detail ? ` - ${result.detail}` : '';
    console.log(`[${icon}] ${result.name}${suffix}`);
  }
}

async function main() {
  const root = process.cwd();
  const configPath = path.resolve(root, option('config', 'SMOKE_CONFIG', DEFAULT_CONFIG));
  const sourceAssetPath = path.resolve(root, option('source-asset', 'SMOKE_SOURCE_ASSET', DEFAULT_SOURCE_ASSET));
  const expectedAppUrl = option('expected-app-url', 'SMOKE_EXPECTED_APP_URL');
  const expectedRedirectUrl = option('expected-redirect-url', 'SMOKE_EXPECTED_REDIRECT_URL');
  const healthUrl = option('backend-health-url', 'SMOKE_BACKEND_HEALTH_URL');
  const expectedCartMappingUrl = option('expected-cart-mapping-url', 'SMOKE_EXPECTED_CART_MAPPING_URL', DEFAULT_EXPECTED_CART_MAPPING_URL);
  const storefrontUrl = option('storefront-url', 'SMOKE_STOREFRONT_URL');
  const storefrontPassword = option('storefront-password', 'SMOKE_STOREFRONT_PASSWORD');
  const providedAssetUrl = option('asset-url', 'SMOKE_CART_TOKEN_ASSET_URL');

  const results = [];
  results.push(...await checkAppConfig(configPath, expectedAppUrl, expectedRedirectUrl));
  results.push(await checkBackendHealth(healthUrl));
  results.push(await checkSourceAsset(sourceAssetPath, expectedCartMappingUrl));

  const discovered = providedAssetUrl
    ? { check: pass('storefront asset discovery skipped', 'Using SMOKE_CART_TOKEN_ASSET_URL'), assetUrl: providedAssetUrl }
    : await discoverAssetFromStorefront(storefrontUrl, storefrontPassword);

  results.push(discovered.check);
  results.push(await checkReleasedAsset(discovered.assetUrl, expectedCartMappingUrl));

  printResults(results);

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    console.error(`\nRelease smoke failed: ${failures.length} check(s) failed.`);
    process.exit(1);
  }

  console.log('\nRelease smoke passed.');
}

main().catch((error) => {
  console.error(`Release smoke crashed: ${error.stack || error.message}`);
  process.exit(1);
});
