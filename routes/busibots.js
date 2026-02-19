const express = require('express');
const router = express.Router();
const { query, getClient } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

// Get all bots for a user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM business_bots WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bots:', error);
    res.status(500).json({ error: 'Failed to fetch bots' });
  }
});

// Get a single bot by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM business_bots WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching bot:', error);
    res.status(500).json({ error: 'Failed to fetch bot' });
  }
});

// Create a new bot
router.post('/', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    console.log('Creating bot for user:', req.user.userId);
    
    // Get user and subscription info
    let userPlan = 'free';
    
    try {
      // Try to get subscription
      const subscriptionResult = await client.query(
        'SELECT plan FROM subscriptions WHERE user_id = $1',
        [req.user.userId]
      );
      
      if (subscriptionResult.rows.length > 0) {
        userPlan = subscriptionResult.rows[0].plan || 'free';
      }
    } catch (subError) {
      console.log('Could not fetch subscription, using free plan:', subError.message);
      userPlan = 'free';
    }
    
    console.log('User plan:', userPlan);
    
    // Check bot limit based on subscription
    const botCountResult = await client.query(
      'SELECT COUNT(*) as count FROM business_bots WHERE user_id = $1',
      [req.user.userId]
    );
    
    const currentBotCount = parseInt(botCountResult.rows[0].count);
    console.log('Current bot count:', currentBotCount);
    
    // Bot limits by plan
    const botLimits = {
      free: 1,
      business: 1000000,
      starter: 3,
      professional: 5,
      custom: -1 // unlimited
    };
    
    const limit = botLimits[userPlan] || 1;
    console.log('Bot limit for plan:', limit);
    
    if (limit !== -1 && currentBotCount >= limit) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        error: `You have reached your bot limit (${limit} bots). Please upgrade your plan.`,
        limitReached: true
      });
    }
    
    const {
      name,
      description,
      industry,
      language,
      personality,
      trainingData,
      welcomeMessage,
      fallbackMessage,
      branding,
      features,
      security,
      trainingFiles,
      dataAnalysis
    } = req.body;
    
    console.log('Bot data received:', { name, industry, language });
    
    // Validate required fields
    if (!name) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bot name is required' });
    }
    
    // Generate unique bot_id and api_key
    const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const apiKey = `sk_${Math.random().toString(36).substr(2, 16)}_${Math.random().toString(36).substr(2, 16)}`;
    const deploymentUrl = `https://botlyra.com/chat/${botId}`;
    
    console.log('Generated bot_id:', botId);
    
    const result = await client.query(
      `INSERT INTO business_bots (
        bot_id, user_id, name, description, industry, language, personality,
        training_data, welcome_message, fallback_message, branding, features,
        security, training_files, data_analysis, deployment_url, api_key, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        botId,
        req.user.userId,
        name,
        description || '',
        industry || '',
        language || 'en',
        personality || 'professional',
        trainingData || '',
        welcomeMessage || 'Hello! How can I help you today?',
        fallbackMessage || 'I apologize, but I don\'t understand that question. Could you please rephrase it?',
        JSON.stringify(branding || {}),
        JSON.stringify(features || {}),
        JSON.stringify(security || {}),
        JSON.stringify(trainingFiles || []),
        JSON.stringify(dataAnalysis || null),
        deploymentUrl,
        apiKey,
        'active'
      ]
    );
    
    await client.query('COMMIT');
    console.log('Bot created successfully:', result.rows[0].id);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating bot:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to create bot', details: error.message });
  } finally {
    client.release();
  }
});

// Update a bot
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const {
      name,
      description,
      industry,
      language,
      personality,
      trainingData,
      welcomeMessage,
      fallbackMessage,
      branding,
      features,
      security,
      trainingFiles,
      dataAnalysis,
      status
    } = req.body;
    
    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (industry !== undefined) {
      updates.push(`industry = $${paramCount++}`);
      values.push(industry);
    }
    if (language !== undefined) {
      updates.push(`language = $${paramCount++}`);
      values.push(language);
    }
    if (personality !== undefined) {
      updates.push(`personality = $${paramCount++}`);
      values.push(personality);
    }
    if (trainingData !== undefined) {
      updates.push(`training_data = $${paramCount++}`);
      values.push(trainingData);
    }
    if (welcomeMessage !== undefined) {
      updates.push(`welcome_message = $${paramCount++}`);
      values.push(welcomeMessage);
    }
    if (fallbackMessage !== undefined) {
      updates.push(`fallback_message = $${paramCount++}`);
      values.push(fallbackMessage);
    }
    if (branding !== undefined) {
      updates.push(`branding = $${paramCount++}`);
      values.push(JSON.stringify(branding));
    }
    if (features !== undefined) {
      updates.push(`features = $${paramCount++}`);
      values.push(JSON.stringify(features));
    }
    if (security !== undefined) {
      updates.push(`security = $${paramCount++}`);
      values.push(JSON.stringify(security));
    }
    if (trainingFiles !== undefined) {
      updates.push(`training_files = $${paramCount++}`);
      values.push(JSON.stringify(trainingFiles));
    }
    if (dataAnalysis !== undefined) {
      updates.push(`data_analysis = $${paramCount++}`);
      values.push(JSON.stringify(dataAnalysis));
    }
    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updates.push(`last_activity_at = CURRENT_TIMESTAMP`);
    
    values.push(req.params.id, req.user.userId);
    
    const result = await query(
      `UPDATE business_bots 
       SET ${updates.join(', ')}
       WHERE id = $${paramCount++} AND user_id = $${paramCount}
       RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating bot:', error);
    res.status(500).json({ error: 'Failed to update bot' });
  }
});

// Delete a bot
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM business_bots WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json({ message: 'Bot deleted successfully', bot: result.rows[0] });
  } catch (error) {
    console.error('Error deleting bot:', error);
    res.status(500).json({ error: 'Failed to delete bot' });
  }
});

// Duplicate a bot
router.post('/:id/duplicate', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    // Get original bot
    const originalResult = await client.query(
      'SELECT * FROM business_bots WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (originalResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const original = originalResult.rows[0];
    
    // Get user plan
    let userPlan = 'free';
    try {
      const subscriptionResult = await client.query(
        'SELECT plan FROM subscriptions WHERE user_id = $1',
        [req.user.userId]
      );
      
      if (subscriptionResult.rows.length > 0) {
        userPlan = subscriptionResult.rows[0].plan || 'free';
      }
    } catch (subError) {
      console.log('Could not fetch subscription, using free plan');
      userPlan = 'free';
    }
    
    // Check bot limit
    const botCountResult = await client.query(
      'SELECT COUNT(*) as count FROM business_bots WHERE user_id = $1',
      [req.user.userId]
    );
    
    const currentBotCount = parseInt(botCountResult.rows[0].count);
    
    const botLimits = {
      free: 1,
      business: 3,
      starter: 3,
      professional: 10,
      custom: -1
    };
    
    const limit = botLimits[userPlan] || 1;
    
    if (limit !== -1 && currentBotCount >= limit) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        error: `You have reached your bot limit (${limit} bots). Please upgrade your plan.`,
        limitReached: true
      });
    }
    
    // Create duplicate
    const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const apiKey = `sk_${Math.random().toString(36).substr(2, 16)}_${Math.random().toString(36).substr(2, 16)}`;
    const deploymentUrl = `https://botlyra.com/chat/${botId}`;
    
    const result = await client.query(
      `INSERT INTO business_bots (
        bot_id, user_id, name, description, industry, language, personality,
        training_data, welcome_message, fallback_message, branding, features,
        security, training_files, data_analysis, deployment_url, api_key, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        botId,
        req.user.userId,
        `${original.name} (Copy)`,
        original.description,
        original.industry,
        original.language,
        original.personality,
        original.training_data,
        original.welcome_message,
        original.fallback_message,
        original.branding,
        original.features,
        original.security,
        original.training_files,
        original.data_analysis,
        deploymentUrl,
        apiKey,
        'active'
      ]
    );
    
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error duplicating bot:', error);
    res.status(500).json({ error: 'Failed to duplicate bot' });
  } finally {
    client.release();
  }
});

// Increment bot metrics (conversations, messages, users)
router.post('/:id/metrics', authenticateToken, async (req, res) => {
  try {
    const { metricType, value = 1 } = req.body;
    
    const validMetrics = ['conversation_count', 'message_count', 'user_count'];
    if (!validMetrics.includes(metricType)) {
      return res.status(400).json({ error: 'Invalid metric type' });
    }
    
    const result = await query(
      `UPDATE business_bots 
       SET ${metricType} = ${metricType} + $1, last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [value, req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating bot metrics:', error);
    res.status(500).json({ error: 'Failed to update bot metrics' });
  }
});

// Get bot analytics
router.get('/:id/analytics', authenticateToken, async (req, res) => {
  try {
    const { timeRange = '7d' } = req.query;
    
    const botResult = await query(
      'SELECT * FROM business_bots WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (botResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const bot = botResult.rows[0];
    
    // Mock analytics data - replace with actual analytics queries
    const analytics = {
      timeRange,
      totalConversations: bot.conversation_count || 0,
      totalMessages: bot.message_count || 0,
      totalUsers: bot.user_count || 0,
      avgResponseTime: bot.avg_response_time || 0.8,
      satisfactionRate: bot.satisfaction_rate || 92,
      dailyStats: generateMockDailyStats(timeRange),
      topQuestions: [],
      userSentiment: { positive: 70, neutral: 20, negative: 10 }
    };
    
    res.json(analytics);
  } catch (error) {
    console.error('Error fetching bot analytics:', error);
    res.status(500).json({ error: 'Failed to fetch bot analytics' });
  }
});

// Helper function to generate mock daily stats
function generateMockDailyStats(timeRange) {
  const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
  const stats = [];
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    
    stats.push({
      date: date.toISOString().split('T')[0],
      conversations: Math.floor(Math.random() * 50) + 10,
      messages: Math.floor(Math.random() * 200) + 50,
      users: Math.floor(Math.random() * 30) + 5
    });
  }
  
  return stats;
}

// Get bot conversations
router.get('/:id/conversations', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    
    const botResult = await query(
      'SELECT * FROM business_bots WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (botResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    // TODO: Implement actual conversation retrieval
    // For now, return empty array
    res.json({
      conversations: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        pages: 0
      }
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

module.exports = router;