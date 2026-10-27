CREATE DATABASE IF NOT EXISTS ledger_db;
USE ledger_db;

CREATE TABLE IF NOT EXISTS accounts (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    balance DECIMAL(15, 2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);



CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(36) PRIMARY KEY,
    account_id VARCHAR(36) NOT NULL,
    type ENUM('credit', 'debit') NOT NULL,
    amount DECIMAL(15, 2) NOT NULL CHECK (amount > 0),
    description TEXT,
    reference_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    UNIQUE KEY unique_account_ref (account_id, reference_id)
);


DELIMITER //
CREATE TRIGGER prevent_transaction_update
BEFORE UPDATE ON transactions
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Transactions are immutable and cannot be updated.';
END;//


CREATE TRIGGER prevent_transaction_delete
BEFORE DELETE ON transactions
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Transactions are immutable and cannot be deleted.';
END;//
DELIMITER ;