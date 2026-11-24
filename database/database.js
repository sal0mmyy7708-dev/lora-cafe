
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(
  path.join(__dirname, "lora-cafe.db")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ========================================
// Safe database migration helper
// ========================================

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(
    `PRAGMA table_info(${table})`
  ).all();

  const exists = columns.some(
    (item) => item.name === column
  );

  if (!exists) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );

    console.log(`Added column: ${table}.${column}`);
  }
}

// ========================================
// Users
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

addColumnIfMissing("users", "phone", "TEXT");
addColumnIfMissing("users", "address", "TEXT");
addColumnIfMissing("users", "points", "INTEGER DEFAULT 0");

// ========================================
// Branches
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    address TEXT,
    phone TEXT,
    opening_hours TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const defaultBranch = db.prepare(`
  INSERT OR IGNORE INTO branches (
    name,
    address,
    phone,
    opening_hours,
    is_active
  )
  VALUES (?, ?, ?, ?, 1)
`);

defaultBranch.run(
  "LORA Café - Main Branch",
  "Main Branch",
  "",
  "Daily: 9:00 AM - 12:00 AM"
);

const mainBranch = db.prepare(`
  SELECT id FROM branches
  WHERE name = ?
`).get("LORA Café - Main Branch");

// ========================================
// Products
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL DEFAULT 0,
    image TEXT,
    is_available INTEGER DEFAULT 1
  );
`);

addColumnIfMissing("products", "subcategory", "TEXT");
addColumnIfMissing("products", "stock_quantity", "INTEGER DEFAULT 100");
addColumnIfMissing("products", "low_stock_threshold", "INTEGER DEFAULT 5");
addColumnIfMissing("products", "is_featured", "INTEGER DEFAULT 0");
addColumnIfMissing("products", "is_new", "INTEGER DEFAULT 0");
addColumnIfMissing("products", "is_bestseller", "INTEGER DEFAULT 0");
addColumnIfMissing("products", "sku", "TEXT");
addColumnIfMissing("products", "updated_at", "TEXT");
addColumnIfMissing("products", "is_deleted", "INTEGER DEFAULT 0");

// ========================================
// Bookings
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT,
    email TEXT,
    customer_name TEXT,
    customer_email TEXT,
    booking_date TEXT NOT NULL,
    booking_time TEXT NOT NULL,
    guests INTEGER NOT NULL,
    phone TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

addColumnIfMissing("bookings", "customer_name", "TEXT");
addColumnIfMissing("bookings", "customer_email", "TEXT");
addColumnIfMissing("bookings", "phone", "TEXT");
addColumnIfMissing(
  "bookings",
  "branch_id",
  "INTEGER REFERENCES branches(id)"
);

db.exec(`
  UPDATE bookings
  SET customer_name = name
  WHERE customer_name IS NULL AND name IS NOT NULL;

  UPDATE bookings
  SET customer_email = email
  WHERE customer_email IS NULL AND email IS NOT NULL;
`);

// ========================================
// Orders
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    customer_name TEXT,
    customer_email TEXT,
    phone TEXT,
    address TEXT,
    notes TEXT,
    total REAL NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

addColumnIfMissing("orders", "coupon_code", "TEXT");
addColumnIfMissing("orders", "discount", "REAL DEFAULT 0");
addColumnIfMissing("orders", "subtotal", "REAL DEFAULT 0");
addColumnIfMissing("orders", "payment_method", "TEXT DEFAULT 'cash'");
addColumnIfMissing("orders", "fulfillment_type", "TEXT DEFAULT 'delivery'");
addColumnIfMissing("orders", "tracking_code", "TEXT");
addColumnIfMissing("orders", "updated_at", "TEXT");
addColumnIfMissing(
  "orders",
  "branch_id",
  "INTEGER REFERENCES branches(id)"
);
addColumnIfMissing(
  "orders",
  "promotion_id",
  "INTEGER REFERENCES promotions(id)"
);

db.exec(`
  UPDATE orders
  SET subtotal = total + COALESCE(discount, 0)
  WHERE subtotal IS NULL OR subtotal = 0;

  UPDATE orders
  SET updated_at = created_at
  WHERE updated_at IS NULL;
`);

// ========================================
// Order Items
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    subtotal REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// ========================================
// Favorites
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, product_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// ========================================
// Coupons
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    discount_type TEXT NOT NULL,
    discount_value REAL NOT NULL,
    min_order REAL DEFAULT 0,
    max_uses INTEGER,
    used_count INTEGER DEFAULT 0,
    expires_at TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========================================
// Coupon Redemptions
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (coupon_id) REFERENCES coupons(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
`);

// ========================================
// Loyalty Transactions
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_id INTEGER,
    points INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
`);

// ========================================
// Notifications
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ========================================
// Order Status History
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS order_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    changed_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
  );
`);

// ========================================
// Reviews
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT,
    customer_name TEXT,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

addColumnIfMissing("reviews", "product_id", "INTEGER");
addColumnIfMissing("reviews", "order_id", "INTEGER");
addColumnIfMissing("reviews", "is_verified", "INTEGER DEFAULT 0");

db.exec(`
  UPDATE reviews
  SET customer_name = name
  WHERE customer_name IS NULL AND name IS NOT NULL;
`);

// ========================================
// Inventory: branch-specific product stock
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS product_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(branch_id, product_id),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// ========================================
// Inventory Movement History
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    movement_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    previous_quantity INTEGER NOT NULL DEFAULT 0,
    new_quantity INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    changed_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
  );
`);

// ========================================
// Automatic Promotions
// ========================================

db.exec(`
  CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    discount_type TEXT NOT NULL,
    discount_value REAL NOT NULL,
    min_order REAL DEFAULT 0,
    product_id INTEGER,
    category TEXT,
    starts_at TEXT,
    ends_at TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// ========================================
// Initialize branch inventory safely
// Existing inventory is never overwritten.
// ========================================

if (mainBranch) {
  db.prepare(`
    INSERT OR IGNORE INTO product_inventory (
      branch_id,
      product_id,
      stock_quantity
    )
    SELECT ?, id, COALESCE(stock_quantity, 100)
    FROM products
  `).run(mainBranch.id);
}

// ========================================
// Product Seeds
// INSERT OR IGNORE preserves existing products.
// Categories: coffee, drinks, food, desserts
// ========================================

const products = [
  // Coffee
  {
    name: "Espresso",
    category: "coffee",
    subcategory: "Hot Coffee",
    description: "Rich and bold classic espresso.",
    price: 55,
    image: "https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?w=700",
    featured: 1,
    bestseller: 1
  },
  {
    name: "Cappuccino",
    category: "coffee",
    subcategory: "Hot Coffee",
    description: "Espresso with steamed milk and foam.",
    price: 75,
    image: "https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=700",
    featured: 1,
    bestseller: 1
  },
  {
    name: "Caramel Latte",
    category: "coffee",
    subcategory: "Hot Coffee",
    description: "Smooth latte with sweet caramel.",
    price: 90,
    image: "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=700",
    featured: 1
  },
  {
    name: "Iced Americano",
    category: "coffee",
    subcategory: "Iced Coffee",
    description: "Refreshing iced espresso and water.",
    price: 70,
    image: "https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=700"
  },

  // Drinks
  {
    name: "Iced Chocolate",
    category: "drinks",
    subcategory: "Cold Drinks",
    description: "Cold creamy chocolate drink.",
    price: 85,
    image: "https://images.unsplash.com/photo-1542990253-0b8be9b7c5fb?w=700"
  },
  {
    name: "Fresh Lemonade",
    category: "drinks",
    subcategory: "Fresh Juice",
    description: "Freshly squeezed lemonade.",
    price: 65,
    image: "https://images.unsplash.com/photo-1513558161293-cdaf765edfd4?w=700"
  },
  {
    name: "Iced Caramel Macchiato",
    category: "drinks",
    subcategory: "Iced Coffee",
    description: "Iced coffee with milk and caramel.",
    price: 100,
    image: "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=700"
  },
  {
    name: "Iced Spanish Latte",
    category: "drinks",
    subcategory: "Iced Coffee",
    description: "Creamy iced Spanish-style latte.",
    price: 105,
    image: "https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=700"
  },
  {
    name: "Blue Mojito",
    category: "drinks",
    subcategory: "Mojito",
    description: "Refreshing blue citrus and mint drink.",
    price: 85,
    image: "https://images.unsplash.com/photo-1513558161293-cdaf765edfd4?w=700"
  },
  {
    name: "Strawberry Mojito",
    category: "drinks",
    subcategory: "Mojito",
    description: "Strawberry, mint and refreshing citrus.",
    price: 90,
    image: "https://images.unsplash.com/photo-1513558161293-cdaf765edfd4?w=700"
  },
  {
    name: "Iced Matcha Latte",
    category: "drinks",
    subcategory: "Cold Drinks",
    description: "Iced matcha with creamy milk.",
    price: 110,
    image: "https://images.unsplash.com/photo-1515823064-d6e0c04616a7?w=700"
  },
  {
    name: "Mango Smoothie",
    category: "drinks",
    subcategory: "Smoothies",
    description: "Thick mango fruit smoothie.",
    price: 95,
    image: "https://images.unsplash.com/photo-1505252585461-04db1eb84625?w=700"
  },
  {
    name: "Oreo Milkshake",
    category: "drinks",
    subcategory: "Milkshakes",
    description: "Creamy milkshake with cookie flavor.",
    price: 105,
    image: "https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=700"
  },
  {
    name: "Chocolate Frappe",
    category: "drinks",
    subcategory: "Frappe",
    description: "Blended iced chocolate frappe.",
    price: 100,
    image: "https://images.unsplash.com/photo-1542990253-0b8be9b7c5fb?w=700"
  },
  {
    name: "Vanilla Milkshake",
    category: "drinks",
    subcategory: "Milkshakes",
    description: "Classic creamy vanilla milkshake.",
    price: 95,
    image: "https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=700"
  },
  {
    name: "Caramel Frappuccino",
    category: "drinks",
    subcategory: "Frappe",
    description: "Blended coffee with caramel.",
    price: 110,
    image: "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=700"
  },
  {
    name: "Iced Mocha",
    category: "drinks",
    subcategory: "Iced Coffee",
    description: "Coffee blended with chocolate and milk.",
    price: 95,
    image: "https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=700"
  },
  {
    name: "Peach Iced Tea",
    category: "drinks",
    subcategory: "Iced Tea",
    description: "Chilled peach-flavored iced tea.",
    price: 70,
    image: "https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=700"
  },
  {
    name: "Watermelon Juice",
    category: "drinks",
    subcategory: "Fresh Juice",
    description: "Fresh watermelon juice.",
    price: 75,
    image: "https://images.unsplash.com/photo-1525385133512-2f3bdd039054?w=700"
  },
  {
    name: "Fresh Orange Juice",
    category: "drinks",
    subcategory: "Fresh Juice",
    description: "Freshly squeezed orange juice.",
    price: 80,
    image: "https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=700"
  },
  {
    name: "Lotus Milkshake",
    category: "drinks",
    subcategory: "Milkshakes",
    description: "Creamy milkshake with Lotus biscuit flavor.",
    price: 115,
    image: "https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=700"
  },

  // Food
  {
    name: "Club Sandwich",
    category: "food",
    subcategory: "Sandwiches",
    description: "Classic club sandwich with fresh ingredients.",
    price: 130,
    image: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=700",
    bestseller: 1
  },
  {
    name: "Chicken Pasta",
    category: "food",
    subcategory: "Pasta",
    description: "Creamy chicken pasta.",
    price: 155,
    image: "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=700"
  },
  {
    name: "Beef Burger",
    category: "food",
    subcategory: "Burgers",
    description: "Beef burger served with fresh vegetables.",
    price: 165,
    image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=700",
    featured: 1
  },
  {
    name: "Crispy Chicken Sandwich",
    category: "food",
    subcategory: "Sandwiches",
    description: "Crispy chicken sandwich with house sauce.",
    price: 145,
    image: "https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=700"
  },
  {
    name: "Chicken Burger",
    category: "food",
    subcategory: "Burgers",
    description: "Chicken burger with lettuce and sauce.",
    price: 150,
    image: "https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=700"
  },
  {
    name: "Margherita Pizza",
    category: "food",
    subcategory: "Pizza",
    description: "Classic pizza with tomato and mozzarella.",
    price: 145,
    image: "https://images.unsplash.com/photo-1579751626657-72bc17010498?w=700"
  },
  {
    name: "Chicken Pizza",
    category: "food",
    subcategory: "Pizza",
    description: "Pizza topped with chicken and cheese.",
    price: 175,
    image: "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=700"
  },
  {
    name: "Alfredo Pasta",
    category: "food",
    subcategory: "Pasta",
    description: "Pasta in creamy Alfredo sauce.",
    price: 160,
    image: "https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?w=700"
  },
  {
    name: "Chicken Wings",
    category: "food",
    subcategory: "Sides",
    description: "Chicken wings served with dipping sauce.",
    price: 135,
    image: "https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=700"
  },
  {
    name: "French Fries",
    category: "food",
    subcategory: "Sides",
    description: "Golden crispy French fries.",
    price: 65,
    image: "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=700"
  },
  {
    name: "Loaded Fries",
    category: "food",
    subcategory: "Sides",
    description: "Fries topped with cheese and house sauce.",
    price: 105,
    image: "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=700"
  },
  {
    name: "Grilled Chicken Meal",
    category: "food",
    subcategory: "Meals",
    description: "Grilled chicken served with a side.",
    price: 195,
    image: "https://images.unsplash.com/photo-1532550907401-a500c9a57435?w=700"
  },

  // Desserts
  {
    name: "Chocolate Cake",
    category: "desserts",
    subcategory: "Cakes",
    description: "Rich chocolate cake.",
    price: 95,
    image: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=700",
    bestseller: 1
  },
  {
    name: "Cheesecake",
    category: "desserts",
    subcategory: "Cakes",
    description: "Classic creamy cheesecake.",
    price: 100,
    image: "https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=700"
  },
  {
    name: "Brownies",
    category: "desserts",
    subcategory: "Chocolate Desserts",
    description: "Soft chocolate brownies.",
    price: 75,
    image: "https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=700"
  },
  {
    name: "Molten Chocolate Cake",
    category: "desserts",
    subcategory: "Chocolate Desserts",
    description: "Warm chocolate cake with a soft center.",
    price: 115,
    image: "https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=700"
  },
  {
    name: "Lotus Cheesecake",
    category: "desserts",
    subcategory: "Cakes",
    description: "Cheesecake with Lotus biscuit topping.",
    price: 120,
    image: "https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=700"
  },
  {
    name: "Oreo Cheesecake",
    category: "desserts",
    subcategory: "Cakes",
    description: "Creamy cheesecake with Oreo cookies.",
    price: 115,
    image: "https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=700"
  },
  {
    name: "Classic Waffle",
    category: "desserts",
    subcategory: "Waffles",
    description: "Fresh waffle served with toppings.",
    price: 100,
    image: "https://images.unsplash.com/photo-1562376552-0d160a2f238d?w=700"
  },
  {
    name: "Chocolate Crepe",
    category: "desserts",
    subcategory: "Crepes",
    description: "Crepe filled with chocolate.",
    price: 95,
    image: "https://images.unsplash.com/photo-1519676867240-f03562e64548?w=700"
  },
  {
    name: "Pancakes",
    category: "desserts",
    subcategory: "Pancakes",
    description: "Fluffy pancakes with sweet toppings.",
    price: 105,
    image: "https://images.unsplash.com/photo-1528207776546-365bb710ee93?w=700"
  },
  {
    name: "Tiramisu",
    category: "desserts",
    subcategory: "Cakes",
    description: "Classic Italian-inspired tiramisu.",
    price: 120,
    image: "https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=700"
  },
  {
    name: "Donuts",
    category: "desserts",
    subcategory: "Bakery",
    description: "Soft donuts with sweet glaze.",
    price: 55,
    image: "https://images.unsplash.com/photo-1551024506-0bccd828d307?w=700"
  },
  {
    name: "Chocolate Cookies",
    category: "desserts",
    subcategory: "Bakery",
    description: "Fresh chocolate cookies.",
    price: 50,
    image: "https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=700"
  }
];

// ========================================
// Insert products without replacing old data
// ========================================

const insertProduct = db.prepare(`
  INSERT OR IGNORE INTO products (
    name,
    category,
    description,
    price,
    image,
    is_available,
    subcategory,
    stock_quantity,
    low_stock_threshold,
    is_featured,
    is_new,
    is_bestseller,
    updated_at
  )
  VALUES (
    @name,
    @category,
    @description,
    @price,
    @image,
    1,
    @subcategory,
    100,
    5,
    @featured,
    1,
    @bestseller,
    CURRENT_TIMESTAMP
  )
`);

const insertAllProducts = db.transaction(() => {
  for (const product of products) {
    insertProduct.run({
      ...product,
      featured: product.featured || 0,
      bestseller: product.bestseller || 0
    });
  }
});

insertAllProducts();

// ========================================
// Sync new products with default branch.
// Existing branch quantities are preserved.
// ========================================

if (mainBranch) {
  db.prepare(`
    INSERT OR IGNORE INTO product_inventory (
      branch_id,
      product_id,
      stock_quantity
    )
    SELECT ?, id, stock_quantity
    FROM products
  `).run(mainBranch.id);
}

// ========================================
// Indexes
// ========================================

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_favorites_user
  ON favorites(user_id);

  CREATE INDEX IF NOT EXISTS idx_favorites_product
  ON favorites(product_id);

  CREATE INDEX IF NOT EXISTS idx_orders_user
  ON orders(user_id);

  CREATE INDEX IF NOT EXISTS idx_orders_status
  ON orders(status);

  CREATE INDEX IF NOT EXISTS idx_orders_created
  ON orders(created_at);

  CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items(order_id);

  CREATE INDEX IF NOT EXISTS idx_order_items_product
  ON order_items(product_id);

  CREATE INDEX IF NOT EXISTS idx_reviews_product
  ON reviews(product_id);

  CREATE INDEX IF NOT EXISTS idx_reviews_order
  ON reviews(order_id);

  CREATE INDEX IF NOT EXISTS idx_coupons_code
  ON coupons(code);

  CREATE INDEX IF NOT EXISTS idx_loyalty_user
  ON loyalty_transactions(user_id);

  CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id);

  CREATE INDEX IF NOT EXISTS idx_order_history_order
  ON order_status_history(order_id);

  CREATE INDEX IF NOT EXISTS idx_inventory_product
  ON product_inventory(product_id);

  CREATE INDEX IF NOT EXISTS idx_inventory_branch
  ON product_inventory(branch_id);

  CREATE INDEX IF NOT EXISTS idx_inventory_movements_product
  ON inventory_movements(product_id);

  CREATE INDEX IF NOT EXISTS idx_promotions_active
  ON promotions(is_active);
`);

console.log("LORA Café product catalog is ready!");
console.log("LORA Café inventory and branches are ready!");
console.log("LORA Café database is ready!");

module.exports = db;
