# Transaction Ledger API (Full Stack Assessment)

An atomic, idempotent, and secure backend REST API for managing accounts, credit/debit transaction ledgers, and inter-account money transfers, paired with a real-time web testing dashboard.

## Tech Stack
- **Backend Runtime:** Node.js & Express
- **Database:** MySQL (Relational DB utilizing ACID transactions, `FOR UPDATE` row-level locking, `CHECK` constraints, `UNIQUE` keys, and immutability triggers)
- **Frontend UI:** HTML5, CSS3, JavaScript (Fetch API dashboard for live testing)

---

## How to Run Locally

### 1. Prerequisites
Ensure you have **Node.js** and **MySQL** installed.

### 2. Set Up the Database
Open MySQL Workbench, create the database, and execute the script from `schema.sql`:
```sql
CREATE DATABASE IF NOT EXISTS ledger_db;
USE ledger_db;
-- Run the schema script provided in the repository
