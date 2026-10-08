-- Catálogo de la tienda: lo ejecuta la instancia de procesamiento al arrancar (ver user data en
-- lib/store-backend-stack.ts). Es idempotente: se puede correr varias veces sin duplicar nada.

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  parent_id  INTEGER REFERENCES categories (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           SERIAL PRIMARY KEY,
  sku          VARCHAR(40)    NOT NULL UNIQUE,
  name         VARCHAR(200)   NOT NULL,
  description  TEXT,
  price        NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  category_id  INTEGER        NOT NULL REFERENCES categories (id),
  -- La imagen vive en S3; aquí solo se guarda su clave dentro del bucket.
  image_key    VARCHAR(500),
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);

CREATE TABLE IF NOT EXISTS inventory (
  product_id  INTEGER     PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
  quantity    INTEGER     NOT NULL CHECK (quantity >= 0),
  warehouse   VARCHAR(50) NOT NULL DEFAULT 'principal',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Datos de ejemplo
INSERT INTO categories (name) VALUES ('Ropa'), ('Calzado'), ('Accesorios')
ON CONFLICT (name) DO NOTHING;

INSERT INTO products (sku, name, description, price, category_id, image_key)
SELECT v.sku, v.name, v.description, v.price, c.id, v.image_key
FROM (VALUES
  ('CAM-001', 'Camiseta básica',  'Algodón 100 %',          49900.00, 'Ropa',       'products/CAM-001.jpg'),
  ('TEN-001', 'Tenis urbanos',    'Suela de caucho',       189900.00, 'Calzado',    'products/TEN-001.jpg'),
  ('GOR-001', 'Gorra bordada',    'Talla única ajustable',  39900.00, 'Accesorios', 'products/GOR-001.jpg')
) AS v (sku, name, description, price, category, image_key)
JOIN categories c ON c.name = v.category
ON CONFLICT (sku) DO NOTHING;

INSERT INTO inventory (product_id, quantity)
SELECT id, 100 FROM products
ON CONFLICT (product_id) DO NOTHING;
