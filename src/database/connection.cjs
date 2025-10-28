/**
 * Database Connection Manager
 * Connects to ThinkDrop AI's DuckDB database
 */

const duckdb = require('duckdb');
const path = require('path');
const { createSchema } = require('./schema.cjs');

let db = null;
let connection = null;

async function initializeDatabase() {
  // Conversation service has its own dedicated database
  const dbPath = path.join(__dirname, '../../../../data/conversation.duckdb');
  
  return new Promise((resolve, reject) => {
    try {
      db = new duckdb.Database(dbPath);
      console.log('✅ [DB] Connected to database:', dbPath);
      
      connection = db.connect();
      console.log('✅ [DB] Connection established');
      
      // Create schema for conversation tables
      createSchema(connection)
        .then(() => {
          console.log('✅ [DB] Schema verified');
          resolve();
        })
        .catch(reject);
    } catch (err) {
      console.error('❌ [DB] Failed to initialize:', err);
      reject(err);
    }
  });
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
