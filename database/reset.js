require('dotenv').config();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'database', 'sat_platform.db');

if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('🗑️  Database deleted.');
}

// Re-seed
require('./seed');
