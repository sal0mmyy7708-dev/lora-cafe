
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const db = require("./database/database.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "lora-cafe-local-development-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(__dirname));

// ========================================
// Database schema helpers
// ========================================

function getColumns(table) {
  const allowedTables = [
    "users",
    "products",
    "favorites",
    "orders",
    "order_items",
    "notifications",
    "order_status_history",
    "loyalty_transactions",
    "reviews",
    "coupons",
    "coupon_redemptions",
    "bookings"
  ];

  if (!allowedTables.includes(table)) {
    throw new Error("Invalid table name.");
  }

  return db.prepare(`PRAGMA table_info(${table})`).all()
    .map(column => column.name);
}

function hasColumn(table, column) {
  return getColumns(table).includes(column);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// ========================================
// Authentication middleware
// ========================================

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Please login first."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }

  next();
}

// ========================================
// Helpers
// ========================================

function clean(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function getCoupon(code) {
  return db.prepare(`
    SELECT *
    FROM coupons
    WHERE code = ? COLLATE NOCASE
      AND is_active = 1
  `).get(clean(code, 50).toUpperCase());
}

function calculateCouponDiscount(coupon, subtotal) {
  if (!coupon) return 0;

  if (coupon.expires_at) {
    const expiry = new Date(coupon.expires_at);

    if (Number.isNaN(expiry.getTime()) || expiry < new Date()) {
      return null;
    }
  }

  if (subtotal < Number(coupon.min_order || 0)) {
    return null;
  }

  if (
    coupon.max_uses !== null &&
    coupon.max_uses !== undefined &&
    Number(coupon.used_count) >= Number(coupon.max_uses)
  ) {
    return null;
  }

  const value = Number(coupon.discount_value);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  let discount = 0;

  if (coupon.discount_type === "percentage") {
    if (value > 100) return null;
    discount = subtotal * value / 100;
  } else if (coupon.discount_type === "fixed") {
    discount = value;
  } else {
    return null;
  }

  return Math.min(subtotal, roundMoney(discount));
}

// Supports databases with or without notifications.order_id.
function createNotification(
  userId,
  title,
  message,
  orderId = null,
  type = "general"
) {
  if (!userId) return;

  const columns = getColumns("notifications");
  const fields = ["user_id", "title", "message"];
  const values = [userId, title, message];

  if (columns.includes("order_id")) {
    fields.push("order_id");
    values.push(orderId);
  }

  if (columns.includes("type")) {
    fields.push("type");
    values.push(type);
  }

  const placeholders = fields.map(() => "?").join(", ");

  db.prepare(`
    INSERT INTO notifications (${fields.join(", ")})
    VALUES (${placeholders})
  `).run(...values);
}

// Supports both old/new status columns and a legacy status column.
function addOrderHistory(
  orderId,
  oldStatus,
  newStatus,
  note,
  changedBy = null
) {
  const columns = getColumns("order_status_history");
  const fields = ["order_id"];
  const values = [orderId];

  if (columns.includes("old_status")) {
    fields.push("old_status");
    values.push(oldStatus);
  }

  if (columns.includes("new_status")) {
    fields.push("new_status");
    values.push(newStatus);
  } else if (columns.includes("status")) {
    fields.push("status");
    values.push(newStatus);
  }

  if (columns.includes("note")) {
    fields.push("note");
    values.push(note);
  }

  if (columns.includes("changed_by")) {
    fields.push("changed_by");
    values.push(changedBy);
  }

  const placeholders = fields.map(() => "?").join(", ");

  db.prepare(`
    INSERT INTO order_status_history (${fields.join(", ")})
    VALUES (${placeholders})
  `).run(...values);
}

function getOrderHistory(orderId) {
  const columns = getColumns("order_status_history");

  let oldStatusExpression = "NULL AS old_status";
  let newStatusExpression = "NULL AS new_status";

  if (columns.includes("old_status")) {
    oldStatusExpression = "old_status";
  }

  if (columns.includes("new_status")) {
    newStatusExpression = "new_status";
  } else if (columns.includes("status")) {
    newStatusExpression = "status AS new_status";
  }

  const noteExpression = columns.includes("note")
    ? "note"
    : "NULL AS note";

  const createdExpression = columns.includes("created_at")
    ? "created_at"
    : "NULL AS created_at";

  return db.prepare(`
    SELECT
      ${oldStatusExpression},
      ${newStatusExpression},
      ${noteExpression},
      ${createdExpression}
    FROM order_status_history
    WHERE order_id = ?
    ORDER BY id ASC
  `).all(orderId);
}

// Supports loyalty_transactions with or without transaction_type.
function addLoyaltyTransaction(userId, points, description, orderId, type) {
  const columns = getColumns("loyalty_transactions");

  const fields = ["user_id", "points", "description"];
  const values = [userId, points, description];

  if (columns.includes("order_id")) {
    fields.push("order_id");
    values.push(orderId);
  }

  if (columns.includes("transaction_type")) {
    fields.push("transaction_type");
    values.push(type);
  }

  const placeholders = fields.map(() => "?").join(", ");

  db.prepare(`
    INSERT INTO loyalty_transactions (${fields.join(", ")})
    VALUES (${placeholders})
  `).run(...values);
}

const allowedOrderStatuses = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "completed",
  "cancelled"
];

// ========================================
// Home page
// ========================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ========================================
// Registration
// ========================================

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = clean(req.body.name, 100);
    const email = clean(req.body.email, 254).toLowerCase();
    const password = String(req.body.password || "");

    if (
      !name ||
      !validEmail(email) ||
      password.length < 8 ||
      password.length > 128
    ) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid name, email and password of at least 8 characters."
      });
    }

    const existingUser = db.prepare(
      "SELECT id FROM users WHERE email = ?"
    ).get(email);

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "This email is already registered."
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (name, email, password)
      VALUES (?, ?, ?)
    `).run(name, email, hashedPassword);

    await regenerateSession(req);

    req.session.user = {
      id: result.lastInsertRowid,
      name,
      email,
      role: "customer"
    };

    await saveSession(req);

    res.status(201).json({
      success: true,
      message: "Account created successfully!",
      user: req.session.user
    });

  } catch (error) {
    console.error("Registration error:", error);

    res.status(500).json({
      success: false,
      message: "Could not create account."
    });
  }
});

// ========================================
// Login
// ========================================

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = clean(req.body.email, 254).toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Enter your email and password."
      });
    }

    const user = db.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).get(email);

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    await regenerateSession(req);

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    await saveSession(req);

    res.json({
      success: true,
      user: req.session.user
    });

  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: "Could not login."
    });
  }
});

// ========================================
// Current user and logout
// ========================================

app.get("/api/auth/me", (req, res) => {
  res.json({
    success: true,
    user: req.session.user || null
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Could not logout."
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true
    });
  });
});

// ========================================
// Products
// ========================================

app.get("/api/products", (req, res) => {
  try {
    const deletedFilter = hasColumn("products", "is_deleted")
      ? "AND products.is_deleted = 0"
      : "";

    const products = db.prepare(`
      SELECT
        products.id,
        products.name,
        products.category,
        products.description,
        products.price,
        products.image,
        COALESCE(AVG(reviews.rating), 0) AS average_rating,
        COUNT(reviews.id) AS review_count
      FROM products
      LEFT JOIN reviews
        ON reviews.product_id = products.id
      WHERE products.is_available = 1
        ${deletedFilter}
      GROUP BY products.id
      ORDER BY products.category, products.name
    `).all();

    res.json({
      success: true,
      products
    });

  } catch (error) {
    console.error("Products error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load products."
    });
  }
});

// ========================================
// Product reviews: public list
// ========================================

app.get("/api/products/:id/reviews", (req, res) => {
  try {
    const productId = Number(req.params.id);

    if (!Number.isInteger(productId) || productId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product."
      });
    }

    const product = db.prepare(
      "SELECT id FROM products WHERE id = ?"
    ).get(productId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    const reviews = db.prepare(`
      SELECT
        id,
        customer_name,
        rating,
        comment,
        is_verified,
        created_at
      FROM reviews
      WHERE product_id = ?
      ORDER BY id DESC
    `).all(productId);

    const summary = db.prepare(`
      SELECT
        COALESCE(AVG(rating), 0) AS average_rating,
        COUNT(*) AS review_count
      FROM reviews
      WHERE product_id = ?
    `).get(productId);

    res.json({
      success: true,
      reviews,
      summary
    });

  } catch (error) {
    console.error("Product reviews error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load product reviews."
    });
  }
});

// ========================================
// Customer profile
// ========================================

app.get("/api/profile", requireLogin, (req, res) => {
  try {
    const user = db.prepare(`
      SELECT id, name, email, phone, address, points, created_at
      FROM users
      WHERE id = ?
    `).get(req.session.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    res.json({
      success: true,
      profile: user
    });

  } catch (error) {
    console.error("Profile error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load profile."
    });
  }
});

app.put("/api/profile", requireLogin, (req, res) => {
  try {
    const name = clean(req.body.name, 100);
    const phone = clean(req.body.phone, 30);
    const address = clean(req.body.address, 300);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Name is required."
      });
    }

    db.prepare(`
      UPDATE users
      SET name = ?, phone = ?, address = ?
      WHERE id = ?
    `).run(name, phone, address, req.session.user.id);

    req.session.user.name = name;

    res.json({
      success: true,
      message: "Profile updated successfully."
    });

  } catch (error) {
    console.error("Profile update error:", error);

    res.status(500).json({
      success: false,
      message: "Could not update profile."
    });
  }
});

// ========================================
// Favorites
// ========================================

app.get("/api/favorites", requireLogin, (req, res) => {
  try {
    const deletedFilter = hasColumn("products", "is_deleted")
      ? "AND products.is_deleted = 0"
      : "";

    const favorites = db.prepare(`
      SELECT
        products.id,
        products.name,
        products.category,
        products.description,
        products.price,
        products.image,
        favorites.created_at
      FROM favorites
      JOIN products
        ON products.id = favorites.product_id
      WHERE favorites.user_id = ?
        ${deletedFilter}
      ORDER BY favorites.id DESC
    `).all(req.session.user.id);

    res.json({
      success: true,
      favorites
    });

  } catch (error) {
    console.error("Favorites error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load favorites."
    });
  }
});

app.post("/api/favorites", requireLogin, (req, res) => {
  try {
    const productId = Number(req.body.productId);

    if (!Number.isInteger(productId) || productId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product."
      });
    }

    const deletedFilter = hasColumn("products", "is_deleted")
      ? "AND is_deleted = 0"
      : "";

    const product = db.prepare(`
      SELECT id
      FROM products
      WHERE id = ?
        AND is_available = 1
        ${deletedFilter}
    `).get(productId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    const existing = db.prepare(`
      SELECT id
      FROM favorites
      WHERE user_id = ? AND product_id = ?
    `).get(req.session.user.id, productId);

    if (!existing) {
      db.prepare(`
        INSERT INTO favorites (user_id, product_id)
        VALUES (?, ?)
      `).run(req.session.user.id, productId);
    }

    res.json({
      success: true,
      message: "Added to favorites."
    });

  } catch (error) {
    console.error("Add favorite error:", error);

    res.status(500).json({
      success: false,
      message: "Could not add favorite."
    });
  }
});

app.delete("/api/favorites/:productId", requireLogin, (req, res) => {
  try {
    const productId = Number(req.params.productId);

    if (!Number.isInteger(productId) || productId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product."
      });
    }

    db.prepare(`
      DELETE FROM favorites
      WHERE user_id = ? AND product_id = ?
    `).run(req.session.user.id, productId);

    res.json({
      success: true,
      message: "Removed from favorites."
    });

  } catch (error) {
    console.error("Remove favorite error:", error);

    res.status(500).json({
      success: false,
      message: "Could not remove favorite."
    });
  }
});

// ========================================
// Coupon validation
// ========================================

app.post("/api/coupons/validate", requireLogin, (req, res) => {
  try {
    const code = clean(req.body.code, 50).toUpperCase();
    const subtotal = Number(req.body.subtotal);

    if (!code || !Number.isFinite(subtotal) || subtotal <= 0) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid coupon and order amount."
      });
    }

    const coupon = getCoupon(code);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found or inactive."
      });
    }

    const discount = calculateCouponDiscount(coupon, subtotal);

    if (discount === null) {
      return res.status(400).json({
        success: false,
        message: "This coupon is expired or its conditions are not met."
      });
    }

    res.json({
      success: true,
      code: coupon.code,
      discount,
      total: Math.max(0, roundMoney(subtotal - discount))
    });

  } catch (error) {
    console.error("Coupon validation error:", error);

    res.status(500).json({
      success: false,
      message: "Could not validate coupon."
    });
  }
});

// ========================================
// Checkout and create order
// ========================================

app.post("/api/orders", requireLogin, (req, res) => {
  try {
    const {
      items,
      phone,
      address,
      notes
    } = req.body;

    const fulfillmentType = clean(
      req.body.fulfillmentType || "delivery",
      20
    ).toLowerCase();

    const paymentMethod = clean(
      req.body.paymentMethod || "cash",
      20
    ).toLowerCase();

    const cleanPhone = clean(phone, 30);
    const cleanAddress = clean(address, 300);

    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 30 ||
      typeof phone !== "string" ||
      !cleanPhone ||
      typeof address !== "string" ||
      (fulfillmentType === "delivery" && !cleanAddress) ||
      (notes !== undefined && typeof notes !== "string") ||
      !["delivery", "pickup"].includes(fulfillmentType) ||
      paymentMethod !== "cash"
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid checkout details."
      });
    }

    const quantities = new Map();

    for (const item of items) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);

      if (
        !Number.isInteger(productId) ||
        productId < 1 ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 20
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product or quantity."
        });
      }

      quantities.set(
        productId,
        (quantities.get(productId) || 0) + quantity
      );
    }

    if ([...quantities.values()].some(q => q > 20)) {
      return res.status(400).json({
        success: false,
        message: "Maximum quantity per product is 20."
      });
    }

    const deletedFilter = hasColumn("products", "is_deleted")
      ? "AND is_deleted = 0"
      : "";

    const getProduct = db.prepare(`
      SELECT id, name, price
      FROM products
      WHERE id = ?
        AND is_available = 1
        ${deletedFilter}
    `);

    const orderItems = [];
    let subtotal = 0;

    for (const [productId, quantity] of quantities) {
      const product = getProduct.get(productId);

      if (!product) {
        return res.status(400).json({
          success: false,
          message: "One of the products is unavailable."
        });
      }

      const itemSubtotal = roundMoney(
        Number(product.price) * quantity
      );

      subtotal += itemSubtotal;

      orderItems.push({
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity,
        subtotal: itemSubtotal
      });
    }

    subtotal = roundMoney(subtotal);

    const couponCode = clean(req.body.couponCode, 50).toUpperCase();
    const redeemPoints = Number(req.body.redeemPoints || 0);

    if (!Number.isInteger(redeemPoints) || redeemPoints < 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid points amount."
      });
    }

    const user = db.prepare(`
      SELECT id, name, email, points
      FROM users
      WHERE id = ?
    `).get(req.session.user.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Please login again."
      });
    }

    if (redeemPoints > Number(user.points || 0)) {
      return res.status(400).json({
        success: false,
        message: "You do not have enough loyalty points."
      });
    }

    let coupon = null;
    let couponDiscount = 0;

    if (couponCode) {
      coupon = getCoupon(couponCode);

      if (!coupon) {
        return res.status(400).json({
          success: false,
          message: "Coupon not found or inactive."
        });
      }

      couponDiscount = calculateCouponDiscount(coupon, subtotal);

      if (couponDiscount === null) {
        return res.status(400).json({
          success: false,
          message: "Coupon expired or conditions not met."
        });
      }
    }

    // 10 points = 1 EGP.
    // Points are limited to the amount remaining after the coupon.
    const remainingAfterCoupon = roundMoney(
      Math.max(0, subtotal - couponDiscount)
    );

    const maxRedeemablePoints = Math.floor(
      remainingAfterCoupon * 10 + 0.000001
    );

    if (redeemPoints > maxRedeemablePoints) {
      return res.status(400).json({
        success: false,
        message: "The points discount cannot exceed the remaining order amount."
      });
    }

    const pointsDiscount = roundMoney(redeemPoints / 10);

    const totalDiscount = roundMoney(
      couponDiscount + pointsDiscount
    );

    const total = roundMoney(
      Math.max(0, subtotal - totalDiscount)
    );

    const earnedPoints = Math.floor(total / 10);

    const createOrder = db.transaction(() => {
      if (coupon) {
        const currentCoupon = getCoupon(couponCode);

        if (
          !currentCoupon ||
          calculateCouponDiscount(currentCoupon, subtotal) === null
        ) {
          throw new Error("COUPON_NO_LONGER_VALID");
        }
      }

      const currentUser = db.prepare(
        "SELECT points FROM users WHERE id = ?"
      ).get(user.id);

      if (!currentUser || Number(currentUser.points || 0) < redeemPoints) {
        throw new Error("NOT_ENOUGH_POINTS");
      }

      // Recheck product availability immediately before saving the order.
      for (const item of orderItems) {
        const currentProduct = getProduct.get(item.productId);

        if (!currentProduct) {
          throw new Error("PRODUCT_NO_LONGER_AVAILABLE");
        }
      }

      const result = db.prepare(`
        INSERT INTO orders (
          user_id,
          customer_name,
          customer_email,
          phone,
          address,
          notes,
          total,
          coupon_code,
          discount,
          subtotal,
          payment_method,
          fulfillment_type,
          tracking_code,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        user.id,
        user.name,
        user.email,
        cleanPhone,
        cleanAddress,
        clean(notes, 500),
        total,
        coupon ? coupon.code : null,
        totalDiscount,
        subtotal,
        paymentMethod,
        fulfillmentType,
        "LORA-" + crypto.randomBytes(4).toString("hex").toUpperCase()
      );

      const orderId = result.lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO order_items
        (order_id, product_id, product_name, price, quantity, subtotal)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of orderItems) {
        insertItem.run(
          orderId,
          item.productId,
          item.name,
          item.price,
          item.quantity,
          item.subtotal
        );
      }

      if (coupon) {
        db.prepare(`
          UPDATE coupons
          SET used_count = used_count + 1
          WHERE id = ?
        `).run(coupon.id);

        db.prepare(`
          INSERT INTO coupon_redemptions
          (coupon_id, user_id, order_id)
          VALUES (?, ?, ?)
        `).run(coupon.id, user.id, orderId);
      }

      if (redeemPoints > 0) {
        db.prepare(`
          UPDATE users
          SET points = points - ?
          WHERE id = ?
        `).run(redeemPoints, user.id);

        addLoyaltyTransaction(
          user.id,
          -redeemPoints,
          "Points redeemed on order #" + orderId,
          orderId,
          "redeemed"
        );
      }

      if (earnedPoints > 0) {
        db.prepare(`
          UPDATE users
          SET points = points + ?
          WHERE id = ?
        `).run(earnedPoints, user.id);

        addLoyaltyTransaction(
          user.id,
          earnedPoints,
          "Points earned from order #" + orderId,
          orderId,
          "earned"
        );
      }

      addOrderHistory(
        orderId,
        null,
        "pending",
        "Order created",
        user.id
      );

      createNotification(
        user.id,
        "Order received",
        "Your LORA Café order #" + orderId + " has been received.",
        orderId,
        "order"
      );

      return {
        orderId,
        trackingCode: db.prepare(
          "SELECT tracking_code FROM orders WHERE id = ?"
        ).get(orderId).tracking_code
      };
    });

    const created = createOrder();

    res.status(201).json({
      success: true,
      message: "Your order has been placed!",
      orderId: created.orderId,
      trackingCode: created.trackingCode,
      subtotal,
      discount: totalDiscount,
      total,
      earnedPoints,
      remainingPoints:
        Number(user.points || 0) - redeemPoints + earnedPoints
    });

  } catch (error) {
    console.error("Checkout error:", error);

    if (error.message === "COUPON_NO_LONGER_VALID") {
      return res.status(400).json({
        success: false,
        message: "Coupon is no longer available."
      });
    }

    if (error.message === "NOT_ENOUGH_POINTS") {
      return res.status(400).json({
        success: false,
        message: "Not enough loyalty points."
      });
    }

    if (error.message === "PRODUCT_NO_LONGER_AVAILABLE") {
      return res.status(400).json({
        success: false,
        message: "One of the products is no longer available."
      });
    }

    res.status(500).json({
      success: false,
      message: "Could not place order."
    });
  }
});

// ========================================
// Customer order history
// ========================================

app.get("/api/orders/my", requireLogin, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT
        id,
        total,
        subtotal,
        discount,
        coupon_code,
        payment_method,
        fulfillment_type,
        tracking_code,
        status,
        created_at,
        updated_at
      FROM orders
      WHERE user_id = ?
      ORDER BY id DESC
    `).all(req.session.user.id);

    const getItems = db.prepare(`
      SELECT product_name, price, quantity, subtotal
      FROM order_items
      WHERE order_id = ?
    `);

    res.json({
      success: true,
      orders: orders.map(order => ({
        ...order,
        items: getItems.all(order.id)
      }))
    });

  } catch (error) {
    console.error("Order history error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load order history."
    });
  }
});

// ========================================
// Order tracking
// ========================================

app.get("/api/orders/:id", requireLogin, (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    const order = db.prepare(`
      SELECT *
      FROM orders
      WHERE id = ? AND user_id = ?
    `).get(orderId, req.session.user.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    const items = db.prepare(`
      SELECT product_name, price, quantity, subtotal
      FROM order_items
      WHERE order_id = ?
    `).all(orderId);

    const history = getOrderHistory(orderId);

    res.json({
      success: true,
      order: {
        ...order,
        items,
        history
      }
    });

  } catch (error) {
    console.error("Order tracking error:", error);

    res.status(500).json({
      success: false,
      message: "Could not track order."
    });
  }
});

// ========================================
// Customer notifications
// ========================================

app.get("/api/notifications", requireLogin, (req, res) => {
  try {
    const columns = getColumns("notifications");
    const orderIdExpression = columns.includes("order_id")
      ? "order_id"
      : "NULL AS order_id";

    const typeExpression = columns.includes("type")
      ? "type"
      : "'general' AS type";

    const notifications = db.prepare(`
      SELECT
        id,
        ${orderIdExpression},
        title,
        message,
        ${typeExpression},
        is_read,
        created_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(req.session.user.id);

    const unreadCount = db.prepare(`
      SELECT COUNT(*) AS total
      FROM notifications
      WHERE user_id = ? AND is_read = 0
    `).get(req.session.user.id).total;

    res.json({
      success: true,
      notifications,
      unreadCount
    });

  } catch (error) {
    console.error("Notifications error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load notifications."
    });
  }
});

app.patch("/api/notifications/:id/read", requireLogin, (req, res) => {
  try {
    const notificationId = Number(req.params.id);

    if (!Number.isInteger(notificationId) || notificationId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification."
      });
    }

    const result = db.prepare(`
      UPDATE notifications
      SET is_read = 1
      WHERE id = ? AND user_id = ?
    `).run(notificationId, req.session.user.id);

    if (!result.changes) {
      return res.status(404).json({
        success: false,
        message: "Notification not found."
      });
    }

    res.json({
      success: true,
      message: "Notification marked as read."
    });

  } catch (error) {
    console.error("Mark notification error:", error);

    res.status(500).json({
      success: false,
      message: "Could not update notification."
    });
  }
});

app.patch("/api/notifications/read-all", requireLogin, (req, res) => {
  try {
    db.prepare(`
      UPDATE notifications
      SET is_read = 1
      WHERE user_id = ?
    `).run(req.session.user.id);

    res.json({
      success: true,
      message: "All notifications marked as read."
    });

  } catch (error) {
    console.error("Mark all notifications error:", error);

    res.status(500).json({
      success: false,
      message: "Could not update notifications."
    });
  }
});

// ========================================
// Loyalty points
// ========================================

app.get("/api/loyalty", requireLogin, (req, res) => {
  try {
    const user = db.prepare(
      "SELECT points FROM users WHERE id = ?"
    ).get(req.session.user.id);

    const transactions = db.prepare(`
      SELECT points, description, order_id, created_at
      FROM loyalty_transactions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(req.session.user.id);

    res.json({
      success: true,
      points: user ? Number(user.points || 0) : 0,
      rewardRate: "10 points = 1 EGP",
      transactions
    });

  } catch (error) {
    console.error("Loyalty error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load loyalty points."
    });
  }
});

// ========================================
// Bookings
// ========================================

app.post("/api/bookings", (req, res) => {
  try {
    const {
      customerName,
      customerEmail,
      bookingDate,
      bookingTime,
      guests
    } = req.body;

    const guestCount = Number(guests);
    const name = clean(customerName, 100);
    const email = clean(customerEmail, 254).toLowerCase();

    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(bookingDate || ""));
    const validTime = /^\d{2}:\d{2}$/.test(String(bookingTime || ""));

    if (
      !name ||
      !validEmail(email) ||
      !validDate ||
      !validTime ||
      !Number.isInteger(guestCount) ||
      guestCount < 1 ||
      guestCount > 10
    ) {
      return res.status(400).json({
        success: false,
        message: "Please check your booking details."
      });
    }

    const parsedDate = new Date(`${bookingDate}T${bookingTime}:00`);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== bookingDate
    ) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid booking date and time."
      });
    }

    const result = db.prepare(`
      INSERT INTO bookings
      (user_id, customer_name, customer_email,
       booking_date, booking_time, guests)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.session.user?.id || null,
      name,
      email,
      String(bookingDate),
      String(bookingTime),
      guestCount
    );

    res.status(201).json({
      success: true,
      message: "Your booking request was received!",
      bookingId: result.lastInsertRowid
    });

  } catch (error) {
    console.error("Booking error:", error);

    res.status(500).json({
      success: false,
      message: "Could not save booking."
    });
  }
});

// ========================================
// Reviews
// ========================================

app.post("/api/reviews", requireLogin, (req, res) => {
  try {
    const rating = Number(req.body.rating);
    const comment = clean(req.body.comment, 1000);
    const productId = req.body.productId
      ? Number(req.body.productId)
      : null;

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating must be from 1 to 5."
      });
    }

    if (!comment) {
      return res.status(400).json({
        success: false,
        message: "Please enter a review."
      });
    }

    let verified = 0;
    let orderId = null;

    if (productId !== null) {
      if (!Number.isInteger(productId) || productId < 1) {
        return res.status(400).json({
          success: false,
          message: "Invalid product."
        });
      }

      const product = db.prepare(
        "SELECT id FROM products WHERE id = ?"
      ).get(productId);

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Product not found."
        });
      }

      const purchase = db.prepare(`
        SELECT orders.id
        FROM orders
        JOIN order_items
          ON order_items.order_id = orders.id
        WHERE orders.user_id = ?
          AND order_items.product_id = ?
          AND orders.status = 'completed'
        ORDER BY orders.id DESC
        LIMIT 1
      `).get(req.session.user.id, productId);

      if (!purchase) {
        return res.status(403).json({
          success: false,
          message: "You can review this product after completing an order containing it."
        });
      }

      verified = 1;
      orderId = purchase.id;

      // Prevent multiple reviews for the same product in the same order.
      const existingReview = db.prepare(`
        SELECT id
        FROM reviews
        WHERE user_id = ?
          AND product_id = ?
          AND order_id = ?
      `).get(req.session.user.id, productId, orderId);

      if (existingReview) {
        return res.status(409).json({
          success: false,
          message: "You have already reviewed this product for this order."
        });
      }
    }

    db.prepare(`
      INSERT INTO reviews
      (user_id, customer_name, rating, comment, product_id, order_id, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session.user.id,
      req.session.user.name,
      rating,
      comment,
      productId,
      orderId,
      verified
    );

    res.status(201).json({
      success: true,
      message: "Review submitted successfully!",
      verified,
      orderId
    });

  } catch (error) {
    console.error("Review error:", error);

    res.status(500).json({
      success: false,
      message: "Could not submit review."
    });
  }
});

// ========================================
// Admin dashboard
// ========================================

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  try {
    const customerCount = db.prepare(`
      SELECT COUNT(*) AS total
      FROM users
      WHERE role = 'customer'
    `).get().total;

    const bookingCount = db.prepare(
      "SELECT COUNT(*) AS total FROM bookings"
    ).get().total;

    const reviewCount = db.prepare(
      "SELECT COUNT(*) AS total FROM reviews"
    ).get().total;

    const orderCount = db.prepare(
      "SELECT COUNT(*) AS total FROM orders"
    ).get().total;

    const sales = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM orders
      WHERE status != 'cancelled'
    `).get().total;

    const bookings = db.prepare(`
      SELECT id, customer_name, customer_email,
             booking_date, booking_time, guests, status
      FROM bookings
      ORDER BY id DESC
      LIMIT 20
    `).all();

    const orders = db.prepare(`
      SELECT id, customer_name, customer_email,
             phone, total, discount, status, created_at
      FROM orders
      ORDER BY id DESC
      LIMIT 30
    `).all();

    const reviews = db.prepare(`
      SELECT id, customer_name, rating, comment, created_at
      FROM reviews
      ORDER BY id DESC
      LIMIT 20
    `).all();

    const topProducts = db.prepare(`
      SELECT
        order_items.product_name,
        SUM(order_items.quantity) AS quantity_sold,
        SUM(order_items.subtotal) AS revenue
      FROM order_items
      JOIN orders ON orders.id = order_items.order_id
      WHERE orders.status != 'cancelled'
      GROUP BY order_items.product_name
      ORDER BY quantity_sold DESC
      LIMIT 10
    `).all();

    const monthlySales = db.prepare(`
      SELECT
        strftime('%Y-%m', created_at) AS month,
        SUM(total) AS sales,
        COUNT(*) AS orders
      FROM orders
      WHERE status != 'cancelled'
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month DESC
      LIMIT 12
    `).all();

    const averageOrder = db.prepare(`
      SELECT COALESCE(AVG(total), 0) AS average
      FROM orders
      WHERE status != 'cancelled'
    `).get().average;

    res.json({
      success: true,
      bookingCount,
      customerCount,
      reviewCount,
      bookings,
      reviews,

      stats: {
        users: customerCount,
        bookings: bookingCount,
        reviews: reviewCount,
        orders: orderCount,
        sales,
        averageOrder
      },

      orders,
      topProducts,
      monthlySales
    });

  } catch (error) {
    console.error("Admin dashboard error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load dashboard."
    });
  }
});

// ========================================
// Admin advanced sales reports
// ========================================

app.get("/api/admin/reports", requireAdmin, (req, res) => {
  try {
    const from = clean(req.query.from, 10);
    const to = clean(req.query.to, 10);

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;

    if (
      (from && !datePattern.test(from)) ||
      (to && !datePattern.test(to))
    ) {
      return res.status(400).json({
        success: false,
        message: "Dates must use YYYY-MM-DD format."
      });
    }

    if (from && to && from > to) {
      return res.status(400).json({
        success: false,
        message: "Start date must be before end date."
      });
    }

    const dateConditions = [];
    const dateParams = [];

    if (from) {
      dateConditions.push("date(created_at) >= date(?)");
      dateParams.push(from);
    }

    if (to) {
      dateConditions.push("date(created_at) <= date(?)");
      dateParams.push(to);
    }

    const dateWhere = dateConditions.length
      ? "AND " + dateConditions.join(" AND ")
      : "";

    const salesWhere = `status != 'cancelled' ${dateWhere}`;

    const summary = db.prepare(`
      SELECT
        COUNT(*) AS order_count,
        COALESCE(SUM(total), 0) AS total_sales,
        COALESCE(AVG(total), 0) AS average_order,
        COALESCE(SUM(discount), 0) AS total_discounts
      FROM orders
      WHERE ${salesWhere}
    `).get(...dateParams);

    const dailySales = db.prepare(`
      SELECT
        date(created_at) AS day,
        COUNT(*) AS order_count,
        SUM(total) AS sales
      FROM orders
      WHERE ${salesWhere}
      GROUP BY date(created_at)
      ORDER BY day ASC
    `).all(...dateParams);

    const productSales = db.prepare(`
      SELECT
        order_items.product_name,
        SUM(order_items.quantity) AS quantity_sold,
        SUM(order_items.subtotal) AS revenue
      FROM order_items
      JOIN orders
        ON orders.id = order_items.order_id
      WHERE orders.status != 'cancelled'
        ${dateWhere.replaceAll("created_at", "orders.created_at")}
      GROUP BY order_items.product_name
      ORDER BY revenue DESC
      LIMIT 20
    `).all(...dateParams);

    // Include cancelled orders in the status breakdown.
    const statusSummary = db.prepare(`
      SELECT status, COUNT(*) AS total
      FROM orders
      WHERE 1 = 1
        ${dateWhere}
      GROUP BY status
    `).all(...dateParams);

    res.json({
      success: true,
      filters: {
        from: from || null,
        to: to || null
      },
      summary,
      dailySales,
      productSales,
      statusSummary
    });

  } catch (error) {
    console.error("Sales reports error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load sales reports."
    });
  }
});

// ========================================
// Admin update order status + notification
// ========================================

app.patch("/api/admin/orders/:id/status", requireAdmin, (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const status = clean(req.body.status, 30).toLowerCase();

    if (
      !Number.isInteger(orderId) ||
      !allowedOrderStatuses.includes(status)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID or status."
      });
    }

    const order = db.prepare(`
      SELECT id, user_id, status
      FROM orders
      WHERE id = ?
    `).get(orderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    if (order.status === status) {
      return res.json({
        success: true,
        message: "Order already has this status."
      });
    }

    const statusMessages = {
      pending: "Your order is waiting for confirmation.",
      confirmed: "Your order has been confirmed.",
      preparing: "Your order is being prepared.",
      ready: "Your order is ready.",
      completed: "Your order has been completed. Thank you!",
      cancelled: "Your order has been cancelled."
    };

    const updateOrder = db.transaction(() => {
      db.prepare(`
        UPDATE orders
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, orderId);

      addOrderHistory(
        orderId,
        order.status,
        status,
        statusMessages[status],
        req.session.user.id
      );

      createNotification(
        order.user_id,
        "Order update",
        "Order #" + orderId + ": " + statusMessages[status],
        orderId,
        "order"
      );
    });

    updateOrder();

    res.json({
      success: true,
      message: "Order status updated and customer notified."
    });

  } catch (error) {
    console.error("Order status error:", error);

    res.status(500).json({
      success: false,
      message: "Could not update order status."
    });
  }
});

// ========================================
// Admin update booking status
// ========================================

app.patch("/api/admin/bookings/:id/status", requireAdmin, (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const status = clean(req.body.status, 30).toLowerCase();

    const allowedStatuses = [
      "pending",
      "confirmed",
      "completed",
      "cancelled"
    ];

    if (
      !Number.isInteger(bookingId) ||
      !allowedStatuses.includes(status)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID or status."
      });
    }

    const result = db.prepare(`
      UPDATE bookings
      SET status = ?
      WHERE id = ?
    `).run(status, bookingId);

    if (!result.changes) {
      return res.status(404).json({
        success: false,
        message: "Booking not found."
      });
    }

    res.json({
      success: true,
      message: "Booking status updated."
    });

  } catch (error) {
    console.error("Booking status error:", error);

    res.status(500).json({
      success: false,
      message: "Could not update booking status."
    });
  }
});

// ========================================
// Admin coupon management
// ========================================

app.get("/api/admin/coupons", requireAdmin, (req, res) => {
  try {
    const coupons = db.prepare(`
      SELECT id, code, discount_type, discount_value,
             min_order, max_uses, used_count,
             expires_at, is_active, created_at
      FROM coupons
      ORDER BY id DESC
    `).all();

    res.json({
      success: true,
      coupons
    });

  } catch (error) {
    console.error("Admin coupons error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load coupons."
    });
  }
});

app.post("/api/admin/coupons", requireAdmin, (req, res) => {
  try {
    const code = clean(req.body.code, 50).toUpperCase();
    const discountType = clean(req.body.discountType, 20);
    const discountValue = Number(req.body.discountValue);
    const minOrder = Number(req.body.minOrder || 0);

    const maxUses =
      req.body.maxUses === "" ||
      req.body.maxUses === null ||
      req.body.maxUses === undefined
        ? null
        : Number(req.body.maxUses);

    const expiresAt = req.body.expiresAt
      ? clean(req.body.expiresAt, 40)
      : null;

    if (
      !/^[A-Z0-9_-]{3,50}$/.test(code) ||
      !["percentage", "fixed"].includes(discountType) ||
      !Number.isFinite(discountValue) ||
      discountValue <= 0 ||
      (discountType === "percentage" && discountValue > 100) ||
      !Number.isFinite(minOrder) ||
      minOrder < 0 ||
      (maxUses !== null &&
        (!Number.isInteger(maxUses) || maxUses < 1))
    ) {
      return res.status(400).json({
        success: false,
        message: "Please check the coupon details."
      });
    }

    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon expiry date."
      });
    }

    db.prepare(`
      INSERT INTO coupons
      (code, discount_type, discount_value,
       min_order, max_uses, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      code,
      discountType,
      discountValue,
      minOrder,
      maxUses,
      expiresAt
    );

    res.status(201).json({
      success: true,
      message: "Coupon created successfully."
    });

  } catch (error) {
    console.error("Create coupon error:", error);

    if (String(error.code || "").includes("SQLITE_CONSTRAINT")) {
      return res.status(409).json({
        success: false,
        message: "This coupon code already exists."
      });
    }

    res.status(500).json({
      success: false,
      message: "Could not create coupon."
    });
  }
});

app.patch("/api/admin/coupons/:id/status", requireAdmin, (req, res) => {
  try {
    const couponId = Number(req.params.id);
    const isActive = req.body.isActive ? 1 : 0;

    if (!Number.isInteger(couponId) || couponId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon ID."
      });
    }

    const result = db.prepare(`
      UPDATE coupons
      SET is_active = ?
      WHERE id = ?
    `).run(isActive, couponId);

    if (!result.changes) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found."
      });
    }

    res.json({
      success: true,
      message: "Coupon status updated."
    });

  } catch (error) {
    console.error("Coupon status error:", error);

    res.status(500).json({
      success: false,
      message: "Could not update coupon."
    });
  }
});

// ========================================
// Start server
// ========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("LORA Café database is ready!");
  console.log(`LORA Café is running on port ${PORT}`);
});
