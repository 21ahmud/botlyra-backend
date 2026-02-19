const express = require('express');
const { query, getClient } = require('../config/db');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log('Fetching bots for user:', req.user.userId);

    const result = await query(
      `SELECT 
        b.id, b.name, b.description, b.personality, b.language,
        b.status, b.category, b.business_info, b.faq, b.branding,
        b.features, b.bot_type, b.conversation_count, b.message_count, b.user_count,
        b.satisfaction_rate, b.avg_response_time, b.conversion_rate,
        b.created_at, b.updated_at, b.last_activity_at,
        COUNT(DISTINCT c.id) as active_conversations
      FROM bots b
      LEFT JOIN conversations c ON b.id = c.bot_id AND c.status = 'active'
      WHERE b.user_id = $1
      GROUP BY b.id
      ORDER BY b.created_at DESC`,
      [req.user.userId]
    );
    
    console.log(`Found ${result.rows.length} bots for user ${req.user.userId}`);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get bots error:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to get bots', details: error.message });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        b.id, b.name, b.description, b.personality, b.language,
        b.status, b.category, b.business_info, b.faq, b.branding,
        b.features, b.bot_type, b.conversation_count, b.message_count, b.user_count,
        b.satisfaction_rate, b.avg_response_time, b.conversion_rate,
        b.created_at, b.updated_at, b.last_activity_at,
        COUNT(DISTINCT c.id) as active_conversations
      FROM bots b
      LEFT JOIN conversations c ON b.id = c.bot_id AND c.status = 'active'
      WHERE b.id = $1 AND b.user_id = $2
      GROUP BY b.id`,
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get bot error:', error);
    res.status(500).json({ error: 'Failed to get bot' });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    const {
      name, description, businessInfo, faq, language, category,
      personality, branding, features, type
    } = req.body;
    
    console.log('Creating bot with data:', { name, description, category, personality, language, type });
    
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Bot name is required' });
    }
    
    await client.query('BEGIN');
    
    const statsResult = await client.query(
      'SELECT total_bots FROM user_stats WHERE user_id = $1',
      [req.user.userId]
    );
    
    const subscriptionResult = await client.query(
      `SELECT s.plan
       FROM subscriptions s
       WHERE s.user_id = $1 AND s.status = 'active'`,
      [req.user.userId]
    );
    
    if (subscriptionResult.rows.length > 0) {
      const { plan } = subscriptionResult.rows[0];
      const currentBots = statsResult.rows[0]?.total_bots || 0;
      
      const limit = plan === 'free' ? 1 : (plan === 'professional' ? 5 : 999);
      
      if (currentBots >= limit) {
        await client.query('ROLLBACK');
        return res.status(403).json({ 
          error: 'Bot limit reached. Upgrade to create more bots.',
          limitReached: true,
          currentBots,
          maxBots: limit
        });
      }
    }
    
    const defaultBranding = {
      primaryColor: '#3B82F6',
      logo: null,
      welcomeMessage: 'Hello! How can I help you today?',
      ...(branding || {})
    };
    
    const defaultFeatures = {
      voiceAssistant: false,
      analytics: true,
      leadCollection: true,
      multiLanguage: false,
      customBranding: false,
      apiAccess: false,
      ...(features || {})
    };
    
    const botResult = await client.query(
      `INSERT INTO bots (
        user_id, name, description, personality, language,
        category, business_info, faq, branding, features, bot_type, status,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING 
        id, name, description, personality, language, category,
        business_info, faq, branding, features, bot_type, status, conversation_count,
        message_count, user_count, satisfaction_rate, avg_response_time,
        conversion_rate, created_at, updated_at`,
      [
        req.user.userId,
        name.trim(),
        description || '',
        personality || 'professional',
        language || 'english',
        category || 'customer-service',
        businessInfo || '',
        faq || '',
        JSON.stringify(defaultBranding),
        JSON.stringify(defaultFeatures),
        type || 'quick'
      ]
    );
    
    await client.query(
      `INSERT INTO user_stats (user_id, total_bots, created_at, updated_at)
       VALUES ($1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         total_bots = user_stats.total_bots + 1,
         updated_at = CURRENT_TIMESTAMP`,
      [req.user.userId]
    );
    
    await client.query('COMMIT');
    
    console.log('Bot created successfully:', botResult.rows[0]);
    
    res.status(201).json(botResult.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create bot error:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to create bot', details: error.message });
  } finally {
    client.release();
  }
});

router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const {
      name, description, personality, language, category,
      businessInfo, faq, branding, features, status, type
    } = req.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount}`);
      values.push(name);
      paramCount++;
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      values.push(description);
      paramCount++;
    }
    if (personality !== undefined) {
      updates.push(`personality = $${paramCount}`);
      values.push(personality);
      paramCount++;
    }
    if (language !== undefined) {
      updates.push(`language = $${paramCount}`);
      values.push(language);
      paramCount++;
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount}`);
      values.push(category);
      paramCount++;
    }
    if (businessInfo !== undefined) {
      updates.push(`business_info = $${paramCount}`);
      values.push(businessInfo);
      paramCount++;
    }
    if (faq !== undefined) {
      updates.push(`faq = $${paramCount}`);
      values.push(faq);
      paramCount++;
    }
    if (branding !== undefined) {
      updates.push(`branding = $${paramCount}`);
      values.push(JSON.stringify(branding));
      paramCount++;
    }
    if (features !== undefined) {
      updates.push(`features = $${paramCount}`);
      values.push(JSON.stringify(features));
      paramCount++;
    }
    if (status !== undefined) {
      updates.push(`status = $${paramCount}`);
      values.push(status);
      paramCount++;
    }
    if (type !== undefined) {
      updates.push(`bot_type = $${paramCount}`);
      values.push(type);
      paramCount++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id, req.user.userId);
    
    const result = await query(
      `UPDATE bots 
       SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
       RETURNING 
         id, name, description, personality, language, category,
         business_info, faq, branding, features, bot_type, status, conversation_count,
         message_count, user_count, satisfaction_rate, avg_response_time,
         conversion_rate, created_at, updated_at, last_activity_at`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update bot error:', error);
    res.status(500).json({ error: 'Failed to update bot' });
  }
});

router.delete('/:id', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    const checkResult = await client.query(
      'SELECT id FROM bots WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    await client.query(
      `DELETE FROM messages 
       WHERE conversation_id IN (
         SELECT id FROM conversations WHERE bot_id = $1
       )`,
      [req.params.id]
    );
    
    await client.query(
      'DELETE FROM conversations WHERE bot_id = $1',
      [req.params.id]
    );
    
    await client.query(
      'DELETE FROM bots WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    await client.query(
      `UPDATE user_stats 
       SET total_bots = GREATEST(total_bots - 1, 0),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    await client.query('COMMIT');
    
    res.json({ message: 'Bot deleted successfully' });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete bot error:', error);
    res.status(500).json({ error: 'Failed to delete bot' });
  } finally {
    client.release();
  }
});

router.get('/:id/analytics', authenticateToken, async (req, res) => {
  try {
    const { timeRange = '7d' } = req.query;
    
    let timeFilter = "NOW() - INTERVAL '7 days'";
    if (timeRange === '24h') timeFilter = "NOW() - INTERVAL '24 hours'";
    else if (timeRange === '30d') timeFilter = "NOW() - INTERVAL '30 days'";
    else if (timeRange === '90d') timeFilter = "NOW() - INTERVAL '90 days'";
    
    const result = await query(
      `SELECT 
        b.conversation_count,
        b.message_count,
        b.user_count,
        b.satisfaction_rate,
        b.avg_response_time,
        b.conversion_rate,
        b.last_activity_at,
        COUNT(DISTINCT c.id) as total_conversations,
        COUNT(DISTINCT CASE WHEN c.created_at > ${timeFilter} THEN c.id END) as recent_conversations,
        COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.id END) as active_conversations,
        COUNT(DISTINCT m.id) FILTER (WHERE m.created_at > ${timeFilter}) as recent_messages
      FROM bots b
      LEFT JOIN conversations c ON b.id = c.bot_id
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE b.id = $1 AND b.user_id = $2
      GROUP BY b.id`,
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get bot analytics error:', error);
    res.status(500).json({ error: 'Failed to get bot analytics' });
  }
});

router.post('/:id/activity', authenticateToken, async (req, res) => {
  try {
    await query(
      `UPDATE bots 
       SET last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    
    res.json({ message: 'Activity updated' });
  } catch (error) {
    console.error('Update bot activity error:', error);
    res.status(500).json({ error: 'Failed to update activity' });
  }
});

router.post('/:id/metrics', authenticateToken, async (req, res) => {
  try {
    const { metric, value = 1 } = req.body;
    
    const validMetrics = [
      'conversation_count',
      'message_count',
      'user_count'
    ];
    
    if (!validMetrics.includes(metric)) {
      return res.status(400).json({ error: 'Invalid metric' });
    }
    
    await query(
      `UPDATE bots 
       SET ${metric} = ${metric} + $1,
           last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3`,
      [value, req.params.id, req.user.userId]
    );
    
    res.json({ message: 'Metrics updated' });
  } catch (error) {
    console.error('Update bot metrics error:', error);
    res.status(500).json({ error: 'Failed to update metrics' });
  }
});

router.get('/:id/conversations', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;
    
    let queryText = `
      SELECT 
        c.id, c.user_name, c.user_email, c.status,
        c.created_at, c.updated_at, c.last_message_at,
        COUNT(m.id) as message_count,
        MAX(m.created_at) as last_message_time
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE c.bot_id = $1 AND c.bot_id IN (
        SELECT id FROM bots WHERE user_id = $2
      )
    `;
    
    const params = [req.params.id, req.user.userId];
    let paramCount = 3;
    
    if (status) {
      queryText += ` AND c.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }
    
    queryText += `
      GROUP BY c.id
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    
    params.push(limit, offset);
    
    const result = await query(queryText, params);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get bot conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

router.post('/:id/duplicate', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    const originalBot = await client.query(
      'SELECT * FROM bots WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (originalBot.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const bot = originalBot.rows[0];
    
    const statsResult = await client.query(
      'SELECT total_bots FROM user_stats WHERE user_id = $1',
      [req.user.userId]
    );
    
    const subscriptionResult = await client.query(
      `SELECT s.plan
       FROM subscriptions s
       WHERE s.user_id = $1 AND s.status = 'active'`,
      [req.user.userId]
    );
    
    if (subscriptionResult.rows.length > 0) {
      const { plan } = subscriptionResult.rows[0];
      const currentBots = statsResult.rows[0]?.total_bots || 0;
      
      const limit = plan === 'free' ? 1 : (plan === 'professional' ? 5 : 999);
      
      if (currentBots >= limit) {
        await client.query('ROLLBACK');
        return res.status(403).json({ 
          error: 'Bot limit reached. Upgrade to create more bots.',
          limitReached: true
        });
      }
    }
    
    const duplicateResult = await client.query(
      `INSERT INTO bots (
        user_id, name, description, personality, language,
        category, business_info, faq, branding, features, bot_type, status,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', 
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        req.user.userId,
        `${bot.name} (Copy)`,
        bot.description,
        bot.personality,
        bot.language,
        bot.category,
        bot.business_info,
        bot.faq,
        bot.branding,
        bot.features,
        bot.bot_type || 'quick'
      ]
    );
    
    await client.query(
      `UPDATE user_stats 
       SET total_bots = total_bots + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json(duplicateResult.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Duplicate bot error:', error);
    res.status(500).json({ error: 'Failed to duplicate bot' });
  } finally {
    client.release();
  }
});

module.exports = router;