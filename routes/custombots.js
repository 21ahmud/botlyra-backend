const express = require('express');
const { query, getClient } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get plan limits helper
const getPlanLimits = (plan) => {
  const limits = {
    free: { maxCustomBots: 1 },
    business: { maxCustomBots: 5 },
    professional: { maxCustomBots: 20 },
    custom: { maxCustomBots: -1 } // unlimited
  };
  return limits[plan] || limits.free;
};

// Get all custom bots for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        cb.*,
        u.name as owner_name,
        u.email as owner_email
      FROM custom_bots cb
      JOIN users u ON cb.user_id = u.id
      WHERE cb.user_id = $1
      ORDER BY cb.created_at DESC`,
      [req.user.userId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get custom bots error:', error);
    res.status(500).json({ error: 'Failed to fetch custom bots' });
  }
});

// Get single custom bot by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(
      `SELECT cb.*, u.name as owner_name, u.email as owner_email
       FROM custom_bots cb
       JOIN users u ON cb.user_id = u.id
       WHERE cb.id = $1 AND cb.user_id = $2`,
      [id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Custom bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get custom bot error:', error);
    res.status(500).json({ error: 'Failed to fetch custom bot' });
  }
});

// Create new custom bot
router.post('/', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    const {
      name,
      description,
      industry,
      tier,
      personality,
      language,
      features,
      trainingData,
      configuration,
      deployment,
      suggestedQuestions,
      dataAnalysis
    } = req.body;
    
    // Validate required fields
    if (!name || !description) {
      return res.status(400).json({ 
        error: 'Name and description are required' 
      });
    }
    
    await client.query('BEGIN');
    
    // Get user's subscription plan
    const userResult = await client.query(
      `SELECT s.plan 
       FROM users u
       JOIN subscriptions s ON u.id = s.user_id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User subscription not found' });
    }
    
    const userPlan = userResult.rows[0].plan;
    const planLimits = getPlanLimits(userPlan);
    
    // Check bot limit
    if (planLimits.maxCustomBots !== -1) {
      const countResult = await client.query(
        'SELECT COUNT(*) FROM custom_bots WHERE user_id = $1',
        [req.user.userId]
      );
      
      const currentCount = parseInt(countResult.rows[0].count);
      
      if (currentCount >= planLimits.maxCustomBots) {
        await client.query('ROLLBACK');
        return res.status(403).json({ 
          error: `Your ${userPlan} plan allows only ${planLimits.maxCustomBots} custom bot(s). Please upgrade to create more.`,
          limitReached: true,
          currentPlan: userPlan,
          maxBots: planLimits.maxCustomBots
        });
      }
    }
    
    // Create custom bot
    const result = await client.query(
      `INSERT INTO custom_bots (
        user_id, name, description, industry, tier, personality, language,
        features, training_data, configuration, deployment,
        suggested_questions, data_analysis, status, training_progress
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        req.user.userId,
        name,
        description,
        industry || 'technology',
        tier || 'professional',
        personality || 'professional',
        language || 'english',
        JSON.stringify(features || {}),
        JSON.stringify(trainingData || []),
        JSON.stringify(configuration || {}),
        JSON.stringify(deployment || {}),
        JSON.stringify(suggestedQuestions || []),
        dataAnalysis ? JSON.stringify(dataAnalysis) : null,
        'training',
        0
      ]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create custom bot error:', error);
    res.status(500).json({ error: 'Failed to create custom bot' });
  } finally {
    client.release();
  }
});

// Update custom bot
router.put('/:id', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    const { id } = req.params;
    const updates = req.body;
    
    await client.query('BEGIN');
    
    // Verify ownership
    const ownerCheck = await client.query(
      'SELECT id FROM custom_bots WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    
    if (ownerCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Custom bot not found' });
    }
    
    // Build dynamic update query
    const allowedFields = [
      'name', 'description', 'industry', 'tier', 'personality', 'language',
      'features', 'training_data', 'configuration', 'deployment',
      'suggested_questions', 'data_analysis', 'status', 'training_progress',
      'is_active', 'endpoint'
    ];
    
    const updateFields = [];
    const values = [];
    let paramIndex = 1;
    
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      
      if (allowedFields.includes(dbKey)) {
        updateFields.push(`${dbKey} = $${paramIndex}`);
        
        // Handle JSONB fields
        if (['features', 'training_data', 'configuration', 'deployment', 
             'suggested_questions', 'data_analysis'].includes(dbKey)) {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
        paramIndex++;
      }
    }
    
    if (updateFields.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    values.push(id);
    values.push(req.user.userId);
    
    const result = await client.query(
      `UPDATE custom_bots 
       SET ${updateFields.join(', ')}, last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
       RETURNING *`,
      values
    );
    
    await client.query('COMMIT');
    
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update custom bot error:', error);
    res.status(500).json({ error: 'Failed to update custom bot' });
  } finally {
    client.release();
  }
});

// Delete custom bot
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(
      'DELETE FROM custom_bots WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Custom bot not found' });
    }
    
    res.json({ 
      message: 'Custom bot deleted successfully',
      id: result.rows[0].id 
    });
  } catch (error) {
    console.error('Delete custom bot error:', error);
    res.status(500).json({ error: 'Failed to delete custom bot' });
  }
});

// Duplicate custom bot
router.post('/:id/duplicate', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    const { id } = req.params;
    
    await client.query('BEGIN');
    
    // Get user's subscription plan
    const userResult = await client.query(
      `SELECT s.plan 
       FROM users u
       JOIN subscriptions s ON u.id = s.user_id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User subscription not found' });
    }
    
    const userPlan = userResult.rows[0].plan;
    const planLimits = getPlanLimits(userPlan);
    
    // Check bot limit
    if (planLimits.maxCustomBots !== -1) {
      const countResult = await client.query(
        'SELECT COUNT(*) FROM custom_bots WHERE user_id = $1',
        [req.user.userId]
      );
      
      const currentCount = parseInt(countResult.rows[0].count);
      
      if (currentCount >= planLimits.maxCustomBots) {
        await client.query('ROLLBACK');
        return res.status(403).json({ 
          error: `Your ${userPlan} plan allows only ${planLimits.maxCustomBots} custom bot(s). Please upgrade to create more.`,
          limitReached: true,
          currentPlan: userPlan,
          maxBots: planLimits.maxCustomBots
        });
      }
    }
    
    // Get original bot
    const originalBot = await client.query(
      'SELECT * FROM custom_bots WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    
    if (originalBot.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Custom bot not found' });
    }
    
    const bot = originalBot.rows[0];
    
    // Create duplicate
    const result = await client.query(
      `INSERT INTO custom_bots (
        user_id, name, description, industry, tier, personality, language,
        features, training_data, configuration, deployment,
        suggested_questions, data_analysis, status, training_progress
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        req.user.userId,
        `${bot.name} (Copy)`,
        bot.description,
        bot.industry,
        bot.tier,
        bot.personality,
        bot.language,
        bot.features,
        bot.training_data,
        bot.configuration,
        bot.deployment,
        bot.suggested_questions,
        bot.data_analysis,
        'training',
        0
      ]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Duplicate custom bot error:', error);
    res.status(500).json({ error: 'Failed to duplicate custom bot' });
  } finally {
    client.release();
  }
});

// Increment bot metrics/stats
router.post('/:id/metrics', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { metricType, value = 1 } = req.body;
    
    // Map metric types to JSONB paths
    const metricMap = {
      'totalConversations': 'stats.totalConversations',
      'totalMessages': 'stats.totalMessages',
      'uniqueUsers': 'stats.uniqueUsers',
      'conversations': 'stats.totalConversations',
      'messages': 'stats.totalMessages'
    };
    
    const jsonbPath = metricMap[metricType];
    
    if (!jsonbPath) {
      return res.status(400).json({ error: 'Invalid metric type' });
    }
    
    const pathParts = jsonbPath.split('.');
    const field = pathParts[0];
    const key = pathParts[1];
    
    const result = await query(
      `UPDATE custom_bots 
       SET ${field} = jsonb_set(
         ${field},
         '{${key}}',
         (COALESCE((${field}->>'${key}')::integer, 0) + $1)::text::jsonb
       ),
       last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [value, id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Custom bot not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Increment metrics error:', error);
    res.status(500).json({ error: 'Failed to update metrics' });
  }
});

// Get bot analytics
router.get('/:id/analytics', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { timeRange = '7d' } = req.query;
    
    // Verify ownership
    const bot = await query(
      'SELECT * FROM custom_bots WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    
    if (bot.rows.length === 0) {
      return res.status(404).json({ error: 'Custom bot not found' });
    }
    
    // Generate analytics based on time range
    // This is a simplified version - you can expand with actual conversation data
    const analytics = {
      timeRange,
      stats: bot.rows[0].stats,
      monitoring: bot.rows[0].monitoring,
      trends: {
        conversationsGrowth: Math.random() * 20 - 10,
        messagesGrowth: Math.random() * 30 - 15,
        satisfactionGrowth: Math.random() * 10 - 5
      }
    };
    
    res.json(analytics);
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get bot conversations (placeholder - expand with actual conversation table)
router.get('/:id/conversations', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    
    // Verify ownership
    const bot = await query(
      'SELECT id FROM custom_bots WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    
    if (bot.rows.length === 0) {
      return res.status(404).json({ error: 'Custom bot not found' });
    }
    
    // TODO: Implement actual conversation fetching from a conversations table
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
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

module.exports = router;