(function () {
  if (window.__moadCartTokenBlockInstalled) return;
  window.__moadCartTokenBlockInstalled = true;

  const BACKEND_ENDPOINT = "https://moad-api.allurecommerce.com/v1/cart-mapping";
  const STORAGE_KEY = `moad_last_cart_snapshot:${BACKEND_ENDPOINT}`;
  const CART_MUTATION_PATHS = ["/cart/add", "/cart/change", "/cart/update", "/cart/clear"];
  const SYNC_DEBOUNCE_MS = 500;

  let syncTimer = null;
  let syncInFlight = null;
  let internalCartAttributeUpdate = false;

  function getShopifyRoot() {
    return window.Shopify && window.Shopify.routes && window.Shopify.routes.root
      ? window.Shopify.routes.root
      : "/";
  }

  function getCartUrl(path) {
    const root = getShopifyRoot();
    return root.endsWith("/") ? `${root}${path}` : `${root}/${path}`;
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, window.location.origin);
    } catch (_error) {
      return null;
    }
  }

  function isCartMutationUrl(url) {
    const parsed = normalizeUrl(url);
    if (!parsed || parsed.origin !== window.location.origin) return false;
    return CART_MUTATION_PATHS.some((path) => parsed.pathname.endsWith(`${path}.js`) || parsed.pathname === path);
  }

  function hasMoadAttributes(cart) {
    const attributes = cart && cart.attributes;
    return Boolean(
      attributes &&
        attributes.moad_discount_payload &&
        attributes.moad_discount_signature &&
        attributes.moad_discount_version,
    );
  }

  function getStoredCartSignature() {
    try {
      return window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : null;
    } catch (_error) {
      return null;
    }
  }

  function setStoredCartSignature(cartSignature) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, cartSignature);
      }
    } catch (_error) {
      // Storage can be unavailable in strict privacy modes; cart sync should still continue.
    }
  }

  function clearStoredCartSignature() {
    try {
      if (window.localStorage) {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore storage failures; they should not block discount attribute syncing.
    }
  }

  function fetchCart() {
    const url = getCartUrl("cart.js");
    console.log("MOAD fetching cart from:", url);

    return fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    }).then((response) => {
      console.log("MOAD cart response status:", response.status);

      if (!response.ok) {
        throw new Error("Failed to fetch cart");
      }
      return response.json();
    });
  }

  function buildCartSignature(cart) {
    return JSON.stringify({
      token: cart.token,
      item_count: cart.item_count,
      total_price: cart.total_price,
      items: (cart.items || []).map((item) => ({
        key: item.key,
        id: item.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        quantity: item.quantity,
        final_price: item.final_price,
        price: item.price,
      })),
    });
  }

  function sendCartMappingToBackend(payload) {
    console.log("MOAD calling backend:", BACKEND_ENDPOINT);

    return fetch(BACKEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      console.log("MOAD backend response status:", response.status);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Backend returned ${response.status}: ${text}`);
      }
      return response.json();
    });
  }

  function updateCartAttributes(attributes) {
    if (!Array.isArray(attributes) || !attributes.length) {
      return Promise.resolve(false);
    }

    const body = new URLSearchParams();
    attributes.forEach((attribute) => {
      if (attribute && attribute.key && typeof attribute.value === "string") {
        body.append(`attributes[${attribute.key}]`, attribute.value);
      }
    });

    if (!body.toString()) {
      return Promise.resolve(false);
    }

    const url = getCartUrl("cart/update.js");
    console.log("MOAD updating cart attributes through storefront:", url);

    internalCartAttributeUpdate = true;
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
      },
      body,
    })
      .then((response) => {
        console.log("MOAD cart attributes update status:", response.status);
        if (!response.ok) {
          throw new Error(`Cart attributes update failed: ${response.status}`);
        }
        return true;
      })
      .finally(() => {
        internalCartAttributeUpdate = false;
      });
  }

  function getBlockContext() {
    const block = document.querySelector(".moad-cart-token-block");
    if (!block) return null;

    return {
      shopDomain: block.dataset.shopDomain || "",
      customerId: block.dataset.customerId || "",
    };
  }

  function syncCart(reason) {
    const context = getBlockContext();
    if (!context) {
      console.warn("MOAD cart token block not found, skipping sync");
      return Promise.resolve(false);
    }

    if (syncInFlight) {
      return syncInFlight;
    }

    console.log("MOAD cart sync started:", reason || "manual");
    syncInFlight = fetchCart()
      .then((cart) => {
        console.log("MOAD cart response:", cart);

        if (!cart || !cart.token) {
          console.warn("MOAD no cart token found");
          return false;
        }

        if (!cart.item_count || !Array.isArray(cart.items) || cart.items.length === 0) {
          clearStoredCartSignature();
          console.log("MOAD cart is empty, skipping discount sync");
          return false;
        }

        const cartSignature = buildCartSignature(cart);
        const lastCartSignature = getStoredCartSignature();

        if (lastCartSignature === cartSignature && hasMoadAttributes(cart)) {
          console.log("MOAD cart snapshot already synced with attributes, skipping");
          return true;
        }

        const payload = {
          shop: context.shopDomain,
          customerId: context.customerId || null,
          cartToken: cart.token,
          cart,
        };

        console.log("MOAD sending cart mapping payload:", payload);

        return sendCartMappingToBackend(payload).then((result) => {
          console.log("MOAD cart mapping saved successfully:", result);

          if (!result) return false;

          if (result.attributesSynced === true) {
            setStoredCartSignature(cartSignature);
            return true;
          }

          return updateCartAttributes(result.attributes).then((updated) => {
            if (updated) {
              setStoredCartSignature(cartSignature);
            }
            return updated;
          });
        });
      })
      .catch((error) => {
        console.error("MOAD failed to sync cart mapping:", error);
        return false;
      })
      .finally(() => {
        syncInFlight = null;
      });

    return syncInFlight;
  }

  function queueCartSync(reason) {
    if (syncTimer) {
      clearTimeout(syncTimer);
    }

    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncCart(reason);
    }, SYNC_DEBOUNCE_MS);
  }

  function installFetchObserver() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") return;

    window.fetch = function moadObservedFetch(input, init) {
      const requestUrl =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
            ? input.url
            : "";
      const shouldSync = !internalCartAttributeUpdate && isCartMutationUrl(requestUrl);

      return nativeFetch.apply(this, arguments).then((response) => {
        if (shouldSync && response && response.ok) {
          queueCartSync(`fetch:${normalizeUrl(requestUrl)?.pathname || requestUrl}`);
        }
        return response;
      });
    };
  }

  function installXhrObserver() {
    if (!window.XMLHttpRequest) return;

    const nativeOpen = window.XMLHttpRequest.prototype.open;
    const nativeSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function moadObservedOpen(method, url) {
      this.__moadShouldSyncCart = !internalCartAttributeUpdate && isCartMutationUrl(url);
      return nativeOpen.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.send = function moadObservedSend() {
      if (this.__moadShouldSyncCart) {
        this.addEventListener("loadend", () => {
          if (this.status >= 200 && this.status < 300) {
            queueCartSync("xhr:cart-mutation");
          }
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  function init() {
    const blocks = document.querySelectorAll(".moad-cart-token-block");
    console.log("MOAD blocks found:", blocks.length);

    if (!blocks.length) {
      console.warn("MOAD no blocks found, exiting");
      return;
    }

    installFetchObserver();
    installXhrObserver();
    queueCartSync("initial-load");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
