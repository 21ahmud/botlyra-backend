require('dotenv').config();
const { pool, query } = require('./config/db');

async function testConnection() {
  try {
    console.log('Testing database connection...');
    
    // Test basic connection
    const timeResult = await query('SELECT NOW()');
    console.log('✓ Database connected at:', timeResult.rows[0].now);
    
    // Test tables exist
    const tablesResult = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('\n✓ Tables found:');
    tablesResult.rows.forEach(row => {
      console.log('  -', row.table_name);
    });
    
    // Test count of records
    const userCount = await query('SELECT COUNT(*) FROM users');
    console.log('\n✓ Total users:', userCount.rows[0].count);
    
    const subscriptionCount = await query('SELECT COUNT(*) FROM subscriptions');
    console.log('✓ Total subscriptions:', subscriptionCount.rows[0].count);
    
    console.log('\n✅ All tests passed!');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

testConnection();