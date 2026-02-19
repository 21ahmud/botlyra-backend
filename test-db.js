require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 10000,
});

async function testConnection() {
  console.log('Testing connection with:');
  console.log('Host:', process.env.DB_HOST);
  console.log('Port:', process.env.DB_PORT);
  console.log('Database:', process.env.DB_NAME);
  console.log('User:', process.env.DB_USER);
  console.log('Password:', process.env.DB_PASSWORD ? '***' : 'NOT SET');
  
  try {
    const result = await pool.query('SELECT NOW(), current_database(), current_user');
    console.log('\n✅ Database connected successfully!');
    console.log('Current time:', result.rows[0].now);
    console.log('Database:', result.rows[0].current_database);
    console.log('User:', result.rows[0].current_user);
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Connection failed:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

testConnection();