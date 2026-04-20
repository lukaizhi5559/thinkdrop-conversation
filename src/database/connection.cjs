/**
 * Database Connection Manager
 * Connects to ThinkDrop AI's DuckDB database
 */

const duckdb = require('duckdb');
const path = require('path');
const { createSchema } = require('./schema.cjs');

let db = null;
let connection = null;

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

/**
 * Single connection attempt — rejects immediately on any error.
 */
async function _tryConnect(dbPath) {
  return new Promise((resolve, reject) => {
    try {
      const instance = new duckdb.Database(dbPath, (err) => {
        if (err) return reject(err);

        try {
          const conn = instance.connect();
          db = instance;
          connection = conn;
          console.log('✅ [DB] Connected to database:', dbPath);
          resolve();
        } catch (connErr) {
          reject(connErr);
        }
      });

      // duckdb.Database constructor may throw synchronously on some builds
      if (!instance) reject(new Error('duckdb.Database returned falsy'));
    } catch (err) {
      reject(err);
    }
  });
}

async function initializeDatabase() {
  // Store database locally within this MCP service
  const dbPath = path.join(__dirname, '../../data/conversation.duckdb');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await _tryConnect(dbPath);

      // Create schema for conversation tables
      await createSchema(connection);
      console.log('✅ [DB] Schema verified');
      return;
    } catch (err) {
      const isLockError = err.message && err.message.includes('Could not set lock');
      if (isLockError && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(`⚠️ [DB] Database locked (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error('❌ [DB] Failed to initialize after retries:', err.message);
        throw err;
      }
    }
  }
}

function getConnection() {
  if (!connection) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return connection;
}

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    const conn = getConnection();
    conn.all(sql, ...params, (err, rows) => {
      if (err) {
        console.error('❌ [DB] Query error:', err);
        console.error('❌ [DB] SQL:', sql);
        return reject(err);
      }
      resolve(rows);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    const conn = getConnection();
    conn.run(sql, ...params, (err) => {
      if (err) {
        console.error('❌ [DB] Run error:', err);
        console.error('❌ [DB] SQL:', sql);
        return reject(err);
      }
      resolve();
    });
  });
}

function closeDatabase() {
  return new Promise((resolve) => {
    if (connection) {
      connection.close(() => {
        if (db) {
          db.close(() => {
            console.log('✅ [DB] Database closed');
            resolve();
          });
        } else {
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  initializeDatabase,
  getConnection,
  query,
  run,
  closeDatabase
};
