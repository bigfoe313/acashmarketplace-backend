import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";
import crypto from "crypto";
import Stripe from "stripe";
import cors from "cors";  // ✅ add cors

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Enable CORS for your GitHub Pages frontend
app.use(
  cors({
    origin: "https://bigfoe313.github.io", // change if frontend URL changes
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
  const signString = sortedKeys.map((k) => `${k}${params[k]}`).join("");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signString)
    .digest("hex")
    .toUpperCase();

  return `${ALIEXPRESS_BASE_URL}?${sortedKeys
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&")}&sign=${signature}`;
}

// --- Fetch shipping info per product ---
async function getShippingInfo(product) {
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
    sign_method: "sha256",
    timestamp: Date.now().toString(),
  };

  try {
    const url = generateSignedUrl(params, appSecret);
    const response = await fetch(url);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { shipping_fee: "0", min_delivery_days: "N/A", max_delivery_days: "N/A" };
    }
    const result =
      data.aliexpress_affiliate_product_shipping_get_response?.resp_result?.result || {};
    return {
      shipping_fee: result.shipping_fee || "0",
      min_delivery_days: result.min_delivery_days || "N/A",
      max_delivery_days: result.max_delivery_days || "N/A",
    };
  } catch (err) {
    return { shipping_fee: "0", min_delivery_days: "N/A", max_delivery_days: "N/A" };
  }
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
    sign_method: "sha256",
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

// --- AliExpress search ---
async function searchAliExpress(query) {
  const appKey = process.env.ALIEXPRESS_APP_KEY;
  const appSecret = process.env.ALIEXPRESS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("App Key or Secret missing in .env");

  const params = {
    app_key: appKey,
    app_signature: "placeholder",
    method: "aliexpress.affiliate.product.query",
    keywords: query,
    page_no: 1,
    page_size: 20,
    ship_to_country: "US",
    target_currency: "USD",
    target_language: "EN",
    sign_method: "sha256",
    timestamp: Date.now().toString(),
  };

  const url = generateSignedUrl(params, appSecret);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`AliExpress API error: ${response.status}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Invalid JSON response from AliExpress");
  }

  let items =
    data.aliexpress_affiliate_product_query_response?.resp_result?.result?.products
      ?.product || [];

  // filter out clothing/shoes
  items = items.filter((item) => {
    const firstLevel = item.first_level_category_name || "";
    const secondLevel = item.second_level_category_name || "";
    return !firstLevel.includes("Shoes") &&
           !firstLevel.includes("Clothing") &&
           !secondLevel.includes("Clothing");
  });

  const mappedProducts = await Promise.all(
    items.map(async (item) => {
      const shipping = await getShippingInfo(item);
      if (!shipping.shipping_fee) return null;
      return {
        id: item.product_id,
        sku_id: item.sku_id,
        title: item.product_title,
        price: (parseFloat(item.target_sale_price) * 1.5).toFixed(2),
        image: item.product_main_image_url,
        shipping_fee: shipping.shipping_fee,
        min_delivery_days: shipping.min_delivery_days,
        max_delivery_days: shipping.max_delivery_days,
      };
    })
  );

  return mappedProducts.filter((p) => p !== null);
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

// Stripe checkout
app.post("/api/cart/add", async (req, res) => {
  try {
    const { title, price, shipping_fee, image, productId, skuId } = req.body;
    const skuDetails = await getSkuDetails(productId, skuId);
    const color = skuDetails.color || "";
    const skuImage = skuDetails.skuImage || image;

    const totalAmount = parseFloat(price) + parseFloat(shipping_fee);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${title}${color ? ` | ${color}` : ""}`,
              images: [skuImage],
            },
            unit_amount: Math.round(totalAmount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: process.env.SUCCESS_URL || "https://your-frontend.com/success.html",
      cancel_url: process.env.CANCEL_URL || "https://your-frontend.com/cancel.html",
    });

    res.json({ url: session.url });
  } catch (err) {
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

// --- healthcheck ---
app.get("/", (req, res) => {
  res.json({ status: "Backend API is running ✅" });
});

app.listen(PORT, () => {
  console.log(`🚀 API server running on port ${PORT}`);
});
