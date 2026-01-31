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

const ALIEXPRESS_BASE_URL = "https://api-sg.aliexpress.com/sync";

/* =======================
   HELPERS (UNCHANGED)
   ======================= */

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

/* ... ALL OTHER ALIEXPRESS + SKU FUNCTIONS UNCHANGED ... */

/* =======================
   STRIPE CHECKOUT (UPDATED)
   ======================= */

app.post("/api/cart/add", async (req, res) => {
  try {
    const {
      title,
      price,
      shipping_fee,
      stateSalesTax = 0,
      image,
      productId,
      skuId
    } = req.body;

    const skuDetails = await getSkuDetails(productId, skuId);
    const color = skuDetails.color || "";
    const skuImage = skuDetails.skuImage || image;

    const lineItems = [];

    // 🔹 Product
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: {
          name: `${title} ${productId}${color ? ` | ${color}` : ""}`,
          images: [skuImage],
        },
        unit_amount: Math.round(Number(price) * 100),
      },
      quantity: 1,
    });

    // 🔹 Shipping
    if (Number(shipping_fee) > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: "Shipping",
          },
          unit_amount: Math.round(Number(shipping_fee) * 100),
        },
        quantity: 1,
      });
    }

    // 🔹 Sales Tax (NEW)
    if (Number(stateSalesTax) > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: "Sales Tax",
          },
          unit_amount: Math.round(Number(stateSalesTax) * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: lineItems,
      success_url:
        process.env.SUCCESS_URL ||
        "https://www.acashmarketplace.com/success.html",
      cancel_url:
        process.env.CANCEL_URL ||
        "https://www.acashmarketplace.com/cancel.html",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

/* =======================
   METAMASK CHECKOUT (UNCHANGED)
   ======================= */

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

/* =======================
   IMAGE PROXY + HEALTHCHECK
   ======================= */

app.get("/api/image-proxy", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url query");

    const response = await fetch(url);
    if (!response.ok) return res.status(502).send("Failed to fetch image");

    res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send("Image proxy failed");
  }
});

app.get("/", (req, res) => {
  res.json({ status: "Backend API is running ✅" });
});

app.listen(PORT, () => {
  console.log(`🚀 API server running on port ${PORT}`);
});
