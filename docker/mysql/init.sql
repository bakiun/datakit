-- Sample schema for MySQL and MariaDB. User: app / app-secret, database: shop.
CREATE USER 'app'@'%' IDENTIFIED BY 'app-secret';
GRANT ALL ON shop.* TO 'app'@'%';

USE shop;

CREATE TABLE customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  status ENUM('pending', 'paid', 'shipped') NOT NULL DEFAULT 'pending',
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);

INSERT INTO customers (name, email) VALUES
  ('Ada Lovelace', 'ada@example.com'),
  ('Linus Torvalds', 'linus@example.com'),
  ('Grace Hopper', 'grace@example.com');

INSERT INTO orders (customer_id, total, status) VALUES
  (1, 120.50, 'paid'),
  (1, 42.00, 'pending'),
  (2, 310.99, 'shipped');

CREATE VIEW order_totals AS
  SELECT customer_id, COUNT(*) AS orders, SUM(total) AS total FROM orders GROUP BY customer_id;

DELIMITER //
CREATE PROCEDURE mark_shipped(IN order_id INT)
BEGIN
  UPDATE orders SET status = 'shipped' WHERE id = order_id;
END //
CREATE FUNCTION customer_total(cid INT) RETURNS DECIMAL(10, 2) DETERMINISTIC READS SQL DATA
BEGIN
  RETURN (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = cid);
END //
DELIMITER ;
