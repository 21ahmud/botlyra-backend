const { Pool } = require('pg');

// Determine if we're in production
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Only use SSL in production, and handle different providers
  ssl: isProduction 
    ? { 
        rejectUnauthorized: false, // Required for Neon, Railway, and most cloud providers
        // You can add more SSL options if needed
        // ca: process.env.CA_CERT // If you need a specific CA
      }
    : false, // Disable SSL for local development
  max: 10, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 30000, // Return an error after 30 seconds if connection fails
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Log when a client is acquired from the pool
pool.on('acquire', (client) => {
  console.log('✅ Client acquired from pool');
});

// Log when a client is connected
pool.on('connect', (client) => {
  console.log('✅ Database connected successfully');
  client.query('SET timezone = "UTC"');
});

// Log when a client is removed from the pool
pool.on('remove', (client) => {
  console.log('✅ Client removed from pool');
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  // Don't crash the app on pool errors
  if (err.code === 'ECONNREFUSED') {
    console.error('❌ Database connection refused. Make sure the database is running.');
  }
});

// Test the connection immediately
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection test failed:', err.message);
    console.error('❌ Connection string used:', process.env.DATABASE_URL ? '✓ Set' : '✗ Not set');
    
    // Don't exit in production - let the app try to recover
    if (!isProduction) {
      console.log('⚠️ Continuing anyway in development mode...');
    }
  } else {
    console.log('✅ Database connection test successful:', res.rows[0]);
  }
});

// Enhanced query function with better error handling
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    
    // Log slow queries (> 1000ms) in production
    if (duration > 1000) {
      console.warn('⚠️ Slow query detected:', { 
        text: text.substring(0, 100), 
        duration, 
        rows: res.rowCount 
      });
    } else {
      console.log('Executed query', { 
        text: text.substring(0, 50), 
        duration, 
        rows: res.rowCount 
      });
    }
    
    return res;
  } catch (error) {
    console.error('❌ Database query error:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      query: text.substring(0, 100)
    });
    throw error;
  }
};

// Get a client with improved timeout handling
const getClient = async () => {
  const client = await pool.connect();
  
  // Store the original release function
  const release = client.release.bind(client);
  
  // Set a timeout to check for long-held clients
  const timeout = setTimeout(() => {
    console.error('⚠️ A client has been checked out for more than 5 seconds!', {
      query: client.query ? 'Query in progress' : 'Idle'
    });
  }, 5000);
  
  // Override the release function
  client.release = () => {
    clearTimeout(timeout);
    client.release = release;
    return release();
  };
  
  return client;
};

// Graceful shutdown function
const closePool = async () => {
  console.log('🔄 Closing database pool...');
  try {
    await pool.end();
    console.log('✅ Database pool closed successfully');
  } catch (err) {
    console.error('❌ Error closing database pool:', err.message);
  }
};

// Handle application termination
process.on('SIGINT', async () => {
  console.log('📥 Received SIGINT signal');
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('📥 Received SIGTERM signal');
  await closePool();
  process.exit(0);
});

module.exports = {
  query,
  getClient,
  pool,
  closePool
};