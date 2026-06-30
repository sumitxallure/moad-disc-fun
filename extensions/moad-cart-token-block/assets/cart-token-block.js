(function () {
  document.addEventListener("DOMContentLoaded", function () {
    console.log("MOAD SCRIPT STARTED AFTER DOM READY");

    const blocks = document.querySelectorAll(".moad-cart-token-block");
    console.log("Blocks found:", blocks.length);

    if (!blocks.length) {
      console.warn("No blocks found, exiting");
      return;
    }

    const BACKEND_ENDPOINT =
      "https://moad-api.allurecommerce.com/v1/cart-mapping";

    function fetchCart() {
      const url =
        window.Shopify && window.Shopify.routes && window.Shopify.routes.root
          ? window.Shopify.routes.root + "cart.js"
          : "/cart.js";

      console.log("Fetching cart from:", url);

      return fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      }).then((response) => {
        console.log("Cart response status:", response.status);

        if (!response.ok) {
          throw new Error("Failed to fetch cart");
        }
        return response.json();
      });
    }

    function sendCartMappingToBackend(payload) {
      console.log("Calling backend:", BACKEND_ENDPOINT);

      return fetch(BACKEND_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }).then(async (response) => {
        console.log("Backend response status:", response.status);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Backend returned ${response.status}: ${text}`);
        }
        return response.json();
      });
    }

    blocks.forEach((block) => {
      const shopDomain = block.dataset.shopDomain || "";
      const customerId = block.dataset.customerId || "";

      console.log("Shop domain:", shopDomain);
      console.log("Customer ID:", customerId);

      fetchCart()
        .then((cart) => {
          console.log("Cart response:", cart);

          if (!cart || !cart.token) {
            console.warn("No cart token found");
            return;
          }

          const STORAGE_KEY = `moad_last_cart_snapshot:${BACKEND_ENDPOINT}`;

          const cartSignature = JSON.stringify({
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
          const lastCartSignature = localStorage.getItem(STORAGE_KEY);

          if (lastCartSignature === cartSignature) {
            console.log("Cart snapshot already sent, skipping...");
            return;
          }

          const payload = {
            shop: shopDomain,
            customerId: customerId || null,
            cartToken: cart.token,
            cart,
          };

          console.log("Sending cart mapping payload:", payload);

          return sendCartMappingToBackend(payload).then((result) => ({
            result,
            cartSignature,
            storageKey: STORAGE_KEY,
          }));
        })
        .then((syncResult) => {
          if (syncResult) {
            console.log("Cart mapping saved successfully:", syncResult.result);
            if (syncResult.result && syncResult.result.attributesSynced === true) {
              localStorage.setItem(syncResult.storageKey, syncResult.cartSignature);
            }
          }
        })
        .catch((error) => {
          console.error("Failed to save cart mapping:", error);
        });
    });
  });
})();
