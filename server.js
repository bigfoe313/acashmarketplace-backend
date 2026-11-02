import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";
import crypto from "crypto";
import Stripe from "stripe";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(
  cors({
    origin: [
      "https://bigfoe313.github.io",
      "https://www.acashmarketplace.com",
      "https://acashmarketplace.com",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// AliExpress base URL
const ALIEXPRESS_BASE_URL = "https://api-sg.aliexpress.com/sync";

// --- Helper: generate signed AliExpress URL ---
function generateSignedUrl(params, secret) {
  const sortedKeys = Object.keys(params).sort();

  let signString = "";

  for (const key of sortedKeys) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") {
      signString += key + String(value);
    }
  }

  const signature = crypto
    .createHash("md5") // 🔥 FIXED
    .update(secret + signString + secret)
    .digest("hex")
    .toUpperCase();

  const query = sortedKeys
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");

  return `${ALIEXPRESS_BASE_URL}?${query}&sign=${signature}`;
}

// Cache successful shipping results for 6 hours
const shippingCache = new Map();
const SHIPPING_CACHE_TTL = 6 * 60 * 60 * 1000;

const sleep = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function getShippingInfo(product) {
  const cacheKey =
    `${product.product_id}_${product.sku_id || ""}_US_USD`;

  const cached = shippingCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < SHIPPING_CACHE_TTL) {
    return cached.data;
  }

  const appKey = process.env.ALIEXPRESS_APP_KEY;
  const appSecret = process.env.ALIEXPRESS_APP_SECRET;

  const params = {
    app_key: appKey,
    app_signature: "placeholder",
    method: "aliexpress.affiliate.product.shipping.get",
    product_id: product.product_id,
    sku_id: product.sku_id || "",
    ship_to_country: "US",
    target_currency: "USD",
    target_sale_price: product.target_sale_price,
    target_language: "EN",
    tax_rate: product.tax_rate || 0,
    sign_method: "md5",
    timestamp: Date.now().toString(),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = generateSignedUrl(params, appSecret);
      const response = await fetch(url);
      const text = await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch (e) {
        return {
          shipping_fee: "0",
          min_delivery_days: "N/A",
          max_delivery_days: "N/A"
        };
      }

      // Retry AliExpress rate-limit errors
      if (text.includes("ApiCallLimit")) {
        if (attempt < 2) {
          await sleep(1100 * (attempt + 1));
          continue;
        }
      }

      const result =
        data.aliexpress_affiliate_product_shipping_get_response
          ?.resp_result?.result || {};

      const shipping = {
        shipping_fee: result.shipping_fee || "0",
        min_delivery_days: result.min_delivery_days || "N/A",
        max_delivery_days: result.max_delivery_days || "N/A",
      };

      // Cache only successful shipping estimates
      if (
        shipping.min_delivery_days !== "N/A" &&
        shipping.max_delivery_days !== "N/A"
      ) {
        shippingCache.set(cacheKey, {
          data: shipping,
          timestamp: Date.now()
        });
      }

      return shipping;

    } catch (err) {
      console.error("Shipping API error:", err);

      if (attempt < 2) {
        await sleep(1100 * (attempt + 1));
      }
    }
  }

  return {
    shipping_fee: "0",
    min_delivery_days: "N/A",
    max_delivery_days: "N/A"
  };
}

// --- Fetch SKU-specific details ---
async function getSkuDetails(productId, skuId) {
  const appKey = process.env.ALIEXPRESS_APP_KEY;
  const appSecret = process.env.ALIEXPRESS_APP_SECRET;

  const params = {
    app_key: appKey,
    app_signature: "placeholder",
    method: "aliexpress.affiliate.product.sku.detail.get",
    product_id: productId,
    sku_ids: skuId,
    ship_to_country: "US",
    target_currency: "USD",
    target_language: "EN",
    need_deliver_info: "No",
    sign_method: "md5",
    timestamp: Date.now().toString(),
  };

  try {
    const url = generateSignedUrl(params, appSecret);
    const response = await fetch(url);
    const text = await response.text();
    const data = JSON.parse(text);

    const skuInfo =
      data.aliexpress_affiliate_product_sku_detail_get_response?.result?.result
        ?.ae_item_sku_info?.traffic_sku_info_list?.[0] || {};

    return {
      color: skuInfo.color || "",
      skuImage: skuInfo.sku_image_link || "",
    };
  } catch (err) {
    console.error("SKU API error:", err);
    return { color: "", skuImage: "" };
  }
}


// Normalize search phrases and product text
function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Generic product accessory exclusions.
// These are product-type indicators, not individual products.
const accessoryTerms = [
  "bag",
  "backpack",
  "case",
  "cover",
  "sleeve",
  "stand",
  "holder",
  "mount",
  "sticker",
  "decal",
  "skin",
  "screen protector",
  "keyboard cover",
  "desk mat",
  "mouse pad",
  "replacement battery",
  "charger",
  "cable",
  "adapter",
  "cleaning kit"
];

// Determine whether the search is for laptop computers.
function getSearchIntent(query) {
  const q = normalizeText(query);

  if (
    /\b(laptop|laptops|notebook computer|notebook computers)\b/.test(q)
  ) {
    return {
      type: "laptop",
      requiredTerms: ["laptop", "notebook computer", "notebook pc"],
      excludedTerms: accessoryTerms
    };
  }

  return {
    type: "general",
    requiredTerms: q.split(" ").filter(word => word.length > 2),
    excludedTerms: []
  };
}

// Determine whether a product is an accessory.
function containsExcludedTerm(text, terms) {
  return terms.some(term => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
}

// Evaluate the relevance of one AliExpress product.
function scoreProduct(item, intent) {
  const title = normalizeText(item.product_title);
  const category = normalizeText(
    `${item.first_level_category_name || ""} ${
      item.second_level_category_name || ""
    }`
  );

  if (intent.type === "laptop") {
    // Reject clear accessories.
    if (containsExcludedTerm(title, intent.excludedTerms)) {
      return 0;
    }

    // Require evidence that the product is a computer.
    const computerTerms = [
      "laptop",
      "notebook computer",
      "notebook pc"
    ];

    const titleMatch = computerTerms.some(term =>
      title.includes(term)
    );

    if (!titleMatch) {
      return 0;
    }

    let score = 10;

    // Category evidence adds confidence.
    if (
      category.includes("computer") ||
      category.includes("laptop") ||
      category.includes("notebook")
    ) {
      score += 5;
    }

    return score;
  }

  // General searches: score products using the search words.
  const terms = intent.requiredTerms;

  if (terms.length === 0) return 1;

  const matched = terms.filter(term =>
    title.includes(term) || category.includes(term)
  ).length;

  return matched / terms.length;
}

// Reusable product relevance filter.
function filterRelevantProducts(items, query) {
  const intent = getSearchIntent(query);

  return items
    .map(item => ({
      item,
      relevance: scoreProduct(item, intent)
    }))
    .filter(result => result.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .map(result => result.item);
}

// --- AliExpress search ---

async function searchAliExpress(query) {
  const appKey = process.env.ALIEXPRESS_APP_KEY;
  const appSecret = process.env.ALIEXPRESS_APP_SECRET;

  if (!appKey || !appSecret) {
    throw new Error("App Key or Secret missing in .env");
  }

  // Retrieve and combine three pages of AliExpress results.
  let allItems = [];

  for (let page = 1; page <= 3; page++) {
    const params = {
      app_key: appKey,
      method: "aliexpress.affiliate.product.query",
      keywords: query,
      page_no: page,
      page_size: 50,
      ship_to_country: "US",
      target_currency: "USD",
      target_language: "EN",
      tracking_id: "acashmarketplace",
      sign_method: "md5",
      timestamp: Date.now().toString(),
    };

    console.log("SEARCH KEYWORD:", query, "PAGE:", page);
    console.log("PARAMS:", JSON.stringify(params, null, 2));

    const url = generateSignedUrl(params, appSecret);
    const response = await fetch(url);
    const text = await response.text();

    console.log(
      `ALIEXPRESS PAGE ${page} RAW RESPONSE:`,
      text.slice(0, 300)
    );

    if (!response.ok) {
      throw new Error(`AliExpress API error on page ${page}: ${response.status}`);
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON response from AliExpress on page ${page}`);
    }

    let pageItems =
      data?.aliexpress_affiliate_product_query_response
        ?.resp_result
        ?.result
        ?.products
        ?.product || [];

    if (!Array.isArray(pageItems)) {
      pageItems = [];
    }

    console.log(`PAGE ${page} PRODUCT COUNT:`, pageItems.length);

    allItems.push(...pageItems);
  }

  console.log("TOTAL PRODUCTS BEFORE DEDUPLICATION:", allItems.length);

  // Remove duplicate products across pages.
  const uniqueItems = [
    ...new Map(
      allItems.map(item => [String(item.product_id), item])
    ).values()
  ];

  let items = uniqueItems;

  console.log("TOTAL UNIQUE PRODUCTS:", items.length);

  // Diagnostic category logging.
  console.log("SEARCH KEYWORD:", query);

  console.log(
    "ALIEXPRESS CATEGORY RESULTS:",
    items.map(item => ({
      title: item.product_title,
      first_category: item.first_level_category_name,
      second_category: item.second_level_category_name,
      second_category_id: item.second_level_category_id
    }))
  );

  const categoryCounts = {};

  items.forEach(item => {
    const id = item.second_level_category_id;
    const name = item.second_level_category_name || "Unknown";
    const key = `${id} - ${name}`;

    categoryCounts[key] = (categoryCounts[key] || 0) + 1;
  });

  console.log("CATEGORY DISTRIBUTION:", categoryCounts);

  // Apply existing clothing/shoes exclusions.
  items = items.filter((item) => {
    const firstLevel = item.first_level_category_name || "";
    const secondLevel = item.second_level_category_name || "";

    return !firstLevel.includes("Shoes") &&
           !firstLevel.includes("Clothing") &&
           !secondLevel.includes("Clothing");
  });

  // Apply reusable search relevance filtering.
  items = filterRelevantProducts(items, query);

  /*
  // TEMPORARY TEST: Filter camera-glasses search results.
  if (query.toLowerCase().includes("camera glasses")) {
    const allowedCategories = [
      "100000306",
      "200003803",
      "202216602"
    ];

    items = items.filter(item => {
      const categoryId = String(item.second_level_category_id);
      const title = (item.product_title || "").toLowerCase();

      const hasCamera = /\b(camera|photo|video|recording)\b/.test(title);
      const hasGlasses =
        /\b(glasses|eyewear|sunglasses|smart glasses)\b/.test(title);

      return allowedCategories.includes(categoryId) &&
             hasCamera &&
             hasGlasses;
    });
  }
  */

  console.log("PRODUCTS AFTER RELEVANCE FILTER:", items.length);

  // First map products without making shipping API calls.
  const candidates = items.slice(0, 15);

  const mappedProducts = candidates.map(item => ({
    id: item.product_id,
    sku_id: item.sku_id,
    title: item.product_title,
    price: (parseFloat(item.target_sale_price || 0) * 1.5).toFixed(2),
    image: item.product_main_image_url,
    shipping_fee: "0",
    min_delivery_days: "N/A",
    max_delivery_days: "N/A",
  }));

  // Fetch shipping information with controlled concurrency.
  let nextIndex = 0;

  async function shippingWorker() {
    while (nextIndex < candidates.length) {
      const index = nextIndex++;

      const shipping = await getShippingInfo(candidates[index]);

      mappedProducts[index].shipping_fee = shipping.shipping_fee;
      mappedProducts[index].min_delivery_days = shipping.min_delivery_days;
      mappedProducts[index].max_delivery_days = shipping.max_delivery_days;
    }
  }

  await Promise.all([
    shippingWorker(),
    shippingWorker()
  ]);

  return mappedProducts;
}

/* =======================
   API ROUTES
   ======================= */

// Search products
app.get("/api/search", async (req, res) => {
  const query = req.query.q || "";
  if (!query) return res.status(400).json({ error: "Query is required" });
  try {
    const products = await searchAliExpress(query);
    res.json({ query, results: products });
  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// SKU details
app.post("/api/sku-details", async (req, res) => {
  const { productId, skuId } = req.body;
  try {
    const skuDetails = await getSkuDetails(productId, skuId);
    res.json(skuDetails);
  } catch (err) {
    res.status(500).json({ color: "", skuImage: "" });
  }
});

// Stripe checkout with safe sales tax handling
app.post("/api/cart/add", async (req, res) => {
  try {
    const { title, price, shipping_fee, stateSalesTax, image, productId, skuId } = req.body;

    // Get SKU details (color + SKU image)
    const skuDetails = await getSkuDetails(productId, skuId);
    const color = skuDetails.color || "";
    const skuImage = skuDetails.skuImage || image;

    // Convert amounts to numbers and cents
    const baseAmount = Math.round((Number(price) + Number(shipping_fee)) * 100);

    // Safely parse sales tax, default to 0 if invalid
    const taxAmount = Number.isFinite(Number(stateSalesTax))
      ? Math.round(Number(stateSalesTax) * 100)
      : 0;

    // Build line items for Stripe
    const line_items = [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `${title} ${productId}${color ? ` | ${color}` : ""}`,
            images: [skuImage],
          },
          unit_amount: baseAmount,
        },
        quantity: 1,
      },
    ];

    // Include sales tax as a separate line item if > 0
    if (taxAmount > 0) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Sales Tax" },
          unit_amount: taxAmount,
        },
        quantity: 1,
      });
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
shipping_address_collection: {
  allowed_countries: ['US']
},
      success_url: process.env.SUCCESS_URL || "https://www.acashmarketplace.com/success.html",
      cancel_url: process.env.CANCEL_URL || "https://www.acashmarketplace.com/cancel.html",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// MetaMask checkout
app.post("/api/metamask-checkout", async (req, res) => {
  try {
    const { title, price, shipping_fee, image, productId, skuId } = req.body;
    const skuDetails = await getSkuDetails(productId, skuId);
    const color = skuDetails.color || "";
    const skuImage = skuDetails.skuImage || image;

    const basePrice = parseFloat(price);
    const shipping = parseFloat(shipping_fee) || 0;
    const discountTotal = basePrice * 0.9;
    const total = discountTotal + shipping;

    let normalizedImage = skuImage || image;
    if (normalizedImage) normalizedImage = normalizedImage.split("?")[0];
    if (normalizedImage && !normalizedImage.startsWith("http")) {
      normalizedImage = `https:${normalizedImage}`;
    }

    const cart = {
      title,
      productId,
      color,
      image: normalizedImage?.replace(/ /g, "%20"),
      price: basePrice,
      shipping,
      total,
      discountTotal: discountTotal.toFixed(2),
    };

    res.json({ cart });
  } catch (err) {
    res.status(500).json({ error: "Failed to build MetaMask checkout cart" });
  }
});

// ✅ New image proxy endpoint
app.get("/api/image-proxy", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url query");

    const response = await fetch(url);
    if (!response.ok) return res.status(502).send("Failed to fetch image");

    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.set("Content-Type", contentType);
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Image proxy error:", err);
    res.status(500).send("Image proxy failed");
  }
});

// --- healthcheck ---
app.get("/", (req, res) => {
  res.json({ status: "Backend API is running ✅" });
});

app.listen(PORT, () => {
  console.log(`🚀 API server running on port ${PORT}`);
});
