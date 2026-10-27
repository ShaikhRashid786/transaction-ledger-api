const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json()); // Allows Express to read JSON request bodies
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
// ==========================================
// 1. MYSQL DATABASE CONNECTION POOL
// ==========================================
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root123', // <-- Put your MySQL password in .env
    database: process.env.DB_NAME || 'ledger_db',
    waitForConnections: true,
    connectionLimit: 10
});


// ==========================================
// 2. API ENDPOINTS
// ==========================================

// --- API 1: Create Account ---
app.post('/accounts', async (req, res) => {
    try {
        const { name, balance } = req.body;

        // Rule: Client must NOT be allowed to set initial balance
        if (balance !== undefined) {
            return res.status(400).json({
                error: "Client is not allowed to set the initial balance. Balance always starts at 0."
            });
        }

        // Rule: Name is required
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ error: "Account holder 'name' is required." });
        }

        const id = crypto.randomUUID();
        const cleanName = name.trim();

        await pool.execute(
            'INSERT INTO accounts (id, name, balance) VALUES (?, ?, 0.00)',
            [id, cleanName]
        );

        const [rows] = await pool.execute('SELECT * FROM accounts WHERE id = ?', [id]);
        const account = rows[0];

        return res.status(201).json({
            id: account.id,
            name: account.name,
            balance: Number(account.balance),
            created_at: account.created_at
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


// --- API 2: Add Transaction (Credit / Debit) ---
app.post('/transactions', async (req, res) => {
    const { account_id, type, amount, description = '', reference_id } = req.body;

    // 1. Validate Incoming Request Data (Section 7)
    if (!account_id) return res.status(400).json({ error: "account_id is required." });
    if (!['credit', 'debit'].includes(type)) {
        return res.status(400).json({ error: "Invalid transaction type. Must be 'credit' or 'debit'." });
    }
    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount. Amount must be a number greater than 0." });
    }
    if (!reference_id || typeof reference_id !== 'string' || reference_id.trim() === '') {
        return res.status(400).json({ error: "reference_id is required." });
    }

    const connection = await pool.getConnection();
    try {
        // Start Atomic MySQL Transaction (Section 5 & 6)
        await connection.beginTransaction();

        // Check if account exists and lock row for update
        const [accounts] = await connection.execute(
            'SELECT * FROM accounts WHERE id = ? FOR UPDATE',
            [account_id]
        );

        if (accounts.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: "Account not found." });
        }

        // Check for duplicate reference_id on the same account
        const [existingTx] = await connection.execute(
            'SELECT id FROM transactions WHERE account_id = ? AND reference_id = ?',
            [account_id, reference_id.trim()]
        );

        if (existingTx.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                error: "Duplicate transaction: A transaction with this reference_id already exists for this account."
            });
        }

        const currentBalance = Number(accounts[0].balance);
        let newBalance = currentBalance;

        // Calculate new balance & check debit rules
        if (type === 'credit') {
            newBalance = Number((currentBalance + amount).toFixed(2));
        } else if (type === 'debit') {
            if (currentBalance < amount) {
                await connection.rollback();
                return res.status(400).json({
                    error: "Insufficient balance.",
                    current_balance: currentBalance,
                    attempted_debit: amount
                });
            }
            newBalance = Number((currentBalance - amount).toFixed(2));
        }

        const txId = crypto.randomUUID();

        // Step A: Insert Transaction Record
        await connection.execute(
            `INSERT INTO transactions (id, account_id, type, amount, description, reference_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [txId, account_id, type, amount, description, reference_id.trim()]
        );

        // Step B: Update Account Balance
        await connection.execute(
            'UPDATE accounts SET balance = ? WHERE id = ?',
            [newBalance, account_id]
        );

        // Commit both changes together!
        await connection.commit();

        const [txRows] = await connection.execute('SELECT * FROM transactions WHERE id = ?', [txId]);
        const tx = txRows[0];

        return res.status(201).json({
            id: tx.id,
            account_id: tx.account_id,
            type: tx.type,
            amount: Number(tx.amount),
            description: tx.description,
            reference_id: tx.reference_id,
            created_at: tx.created_at,
            new_balance: newBalance
        });

    } catch (err) {
        await connection.rollback();
        return res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});


// --- API 3: Get Account Balance ---
app.get('/accounts/:id/balance', async (req, res) => {
    try {
        const accountId = req.params.id;
        const [rows] = await pool.execute(
            'SELECT id, name, balance, created_at FROM accounts WHERE id = ?',
            [accountId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Account not found." });
        }

        return res.status(200).json({
            account_id: rows[0].id,
            name: rows[0].name,
            balance: Number(rows[0].balance)
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


// --- API 4: Get Transaction History (Filtering, Pagination, Sorting) ---
app.get('/accounts/:id/transactions', async (req, res) => {
    try {
        const accountId = req.params.id;
        const { type } = req.query;
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '10', 10);

        // Validate pagination parameters
        if (isNaN(page) || page < 1 || isNaN(limit) || limit < 1 || limit > 100) {
            return res.status(400).json({
                error: "Invalid pagination parameters. 'page' must be >= 1 and 'limit' must be between 1 and 100."
            });
        }

        // Validate type filter if provided
        if (type && !['credit', 'debit'].includes(type)) {
            return res.status(400).json({
                error: "Invalid filter type. Must be 'credit' or 'debit'."
            });
        }

        // Check if account exists
        const [accounts] = await pool.execute('SELECT id FROM accounts WHERE id = ?', [accountId]);
        if (accounts.length === 0) {
            return res.status(404).json({ error: "Account not found." });
        }

        // Build SQL query dynamically for filtering
        let whereClause = 'WHERE account_id = ?';
        const queryParams = [accountId];

        if (type) {
            whereClause += ' AND type = ?';
            queryParams.push(type);
        }

        // Get total records count for pagination metadata
        const [countResult] = await pool.execute(
            `SELECT COUNT(*) AS total FROM transactions ${whereClause}`,
            queryParams
        );
        const totalRecords = countResult[0].total;
        const totalPages = Math.ceil(totalRecords / limit);
        const offset = (page - 1) * limit;

        // Fetch paginated transactions sorted by latest-first (created_at DESC)
        const [transactions] = await pool.query(
            `SELECT id, account_id, type, amount, description, reference_id, created_at
             FROM transactions
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            [...queryParams, limit, offset]
        );

        return res.status(200).json({
            account_id: accountId,
            pagination: {
                current_page: page,
                page_size: limit,
                total_records: totalRecords,
                total_pages: totalPages
            },
            transactions: transactions.map(tx => ({
                ...tx,
                amount: Number(tx.amount)
            }))
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


// --- API 5 (BONUS): Money Transfer Between Accounts ---
app.post('/transfers', async (req, res) => {
    const { from_account_id, to_account_id, amount, description = 'Account Transfer', reference_id } = req.body;

    if (!from_account_id || !to_account_id) {
        return res.status(400).json({ error: "Both from_account_id and to_account_id are required." });
    }
    if (from_account_id === to_account_id) {
        return res.status(400).json({ error: "Source and destination accounts cannot be the same." });
    }
    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: "Transfer amount must be greater than 0." });
    }
    if (!reference_id || typeof reference_id !== 'string' || reference_id.trim() === '') {
        return res.status(400).json({ error: "reference_id is required." });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check both accounts exist
        const [sourceRows] = await connection.execute(
            'SELECT * FROM accounts WHERE id = ? FOR UPDATE',
            [from_account_id]
        );
        const [destRows] = await connection.execute(
            'SELECT * FROM accounts WHERE id = ? FOR UPDATE',
            [to_account_id]
        );

        if (sourceRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: "Source account not found." });
        }
        if (destRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: "Destination account not found." });
        }

        // Check duplicate reference_id
        const [dupRows] = await connection.execute(
            'SELECT id FROM transactions WHERE (account_id = ? OR account_id = ?) AND reference_id = ?',
            [from_account_id, to_account_id, reference_id.trim()]
        );
        if (dupRows.length > 0) {
            await connection.rollback();
            return res.status(409).json({ error: "Duplicate transfer reference_id." });
        }

        const sourceBalance = Number(sourceRows[0].balance);
        const destBalance = Number(destRows[0].balance);

        if (sourceBalance < amount) {
            await connection.rollback();
            return res.status(400).json({ error: "Insufficient balance in source account." });
        }

        const newSourceBalance = Number((sourceBalance - amount).toFixed(2));
        const newDestBalance = Number((destBalance + amount).toFixed(2));

        const debitTxId = crypto.randomUUID();
        const creditTxId = crypto.randomUUID();

        // 1. Insert Debit Transaction for Source Account
        await connection.execute(
            `INSERT INTO transactions (id, account_id, type, amount, description, reference_id)
             VALUES (?, ?, 'debit', ?, ?, ?)`,
            [debitTxId, from_account_id, amount, description, reference_id.trim()]
        );

        // 2. Insert Credit Transaction for Destination Account
        await connection.execute(
            `INSERT INTO transactions (id, account_id, type, amount, description, reference_id)
             VALUES (?, ?, 'credit', ?, ?, ?)`,
            [creditTxId, to_account_id, amount, description, reference_id.trim()]
        );

        // 3. Update Both Account Balances
        await connection.execute('UPDATE accounts SET balance = ? WHERE id = ?', [newSourceBalance, from_account_id]);
        await connection.execute('UPDATE accounts SET balance = ? WHERE id = ?', [newDestBalance, to_account_id]);

        // Commit all 4 operations atomically!
        await connection.commit();

        return res.status(201).json({
            message: "Transfer completed successfully",
            amount,
            from_account: { account_id: from_account_id, new_balance: newSourceBalance },
            to_account: { account_id: to_account_id, new_balance: newDestBalance }
        });

    } catch (err) {
        await connection.rollback();
        return res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Transaction Ledger API running on http://localhost:${PORT}`);
});