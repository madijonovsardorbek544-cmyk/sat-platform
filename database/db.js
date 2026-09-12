const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sat_platform.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    
    // Polyfill for db.transaction (compatible with better-sqlite3 API)
    db.transaction = function(fn) {
      return function(...args) {
        db.exec('BEGIN TRANSACTION');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      };
    };
    
    initSchema();
  }
  return db;
}

function initSchema() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
}

module.exports = { getDb };
