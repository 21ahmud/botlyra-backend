const express = require('express');
const { query, getClient } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const EnhancedAIService = require('../services/enhanced-ai-service');

const router = express.Router();

// Cache for AI service instances
const aiServiceCache = new Map();

// Helper to get or create AI service
async function getAIService(botId, userId) {
  const cacheKey = `${botId}_${userId}`;
  if (aiServiceCache.has(cacheKey)) {
    return aiServiceCache.get(cacheKey);
  }

  const botResult = await query(
    `SELECT b.*, u.subscription_plan 
     FROM (
       SELECT * FROM bots WHERE id = $1
       UNION
       SELECT * FROM custom_bots WHERE id = $1
     ) b
     JOIN users u ON b.user_id = u.id`,
    [botId]
  );

  if (botResult.rows.length === 0) {
    return null;
  }

  const bot = botResult.rows[0];
  const botConfig = {
    id: bot.id,
    name: bot.name,
    businessName: bot.business_name || bot.name,
    businessType: bot.category || bot.business_type,
    personality: bot.personality || 'professional',
    description: bot.description,
    language: bot.language || 'en',
    plan: bot.subscription_plan || 'free',
    trainingData: bot.training_data,
    location: bot.location,
    products: bot.products,
    team: bot.team
  };

  const aiService = new EnhancedAIService(botConfig);
  
  aiServiceCache.set(cacheKey, aiService);
  
  // Clear cache after 1 hour
  setTimeout(() => {
    aiServiceCache.delete(cacheKey);
  }, 3600000);

  return aiService;
}

router.get('/:botId', authenticateToken, async (req, res) => {
  try {
    const botCheck = await query(
      `SELECT id FROM bots WHERE id = $1 AND user_id = $2
       UNION
       SELECT id FROM custom_bots WHERE id = $1 AND user_id = $2`,
      [req.params.botId, req.user.userId]
    );

    if (botCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const result = await query(
      `SELECT id, bot_id, user_id, message, sender, ai_metadata, created_at,
              reactions, sentiment_score
       FROM bot_chat_messages
       WHERE bot_id = $1 AND user_id = $2
       ORDER BY created_at ASC`,
      [req.params.botId, req.user.userId]
    );

    const messages = result.rows.map(row => ({
      ...row,
      reactions: row.reactions || {},
      ai_metadata: row.ai_metadata ? 
        (typeof row.ai_metadata === 'string' ? JSON.parse(row.ai_metadata) : row.ai_metadata) 
        : null
    }));

    res.json(messages);
  } catch (error) {
    console.error('Get bot chat messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

router.post('/:botId/messages', authenticateToken, async (req, res) => {
  const client = await getClient();

  try {
    const { message, sender, aiMetadata, sentimentScore } = req.body;

    if (!message || !sender) {
      return res.status(400).json({ error: 'Message and sender are required' });
    }

    if (!['user', 'bot'].includes(sender)) {
      return res.status(400).json({ error: 'Invalid sender type' });
    }

    await client.query('BEGIN');

    const botCheck = await client.query(
      `SELECT id, user_id FROM (
         SELECT id, user_id FROM bots WHERE id = $1
         UNION
         SELECT id, user_id FROM custom_bots WHERE id = $1
       ) b`,
      [req.params.botId]
    );

    if (botCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }

    const bot = botCheck.rows[0];

    // Check message limit based on subscription
    const userResult = await client.query(
      'SELECT message_count, subscription_plan FROM users WHERE id = $1',
      [req.user.userId]
    );

    const user = userResult.rows[0];
    const messageLimits = {
      free: 100,
      pro: 1000,
      business: 5000,
      enterprise: 10000
    };

    const limit = messageLimits[user.subscription_plan] || 100;
    
    if (user.message_count >= limit) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        error: 'Message limit reached',
        limit,
        current: user.message_count,
        plan: user.subscription_plan
      });
    }

    const result = await client.query(
      `INSERT INTO bot_chat_messages (
        bot_id, user_id, message, sender, ai_metadata, sentiment_score, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING id, bot_id, user_id, message, sender, ai_metadata, sentiment_score, created_at`,
      [
        req.params.botId,
        req.user.userId,
        message,
        sender,
        aiMetadata ? JSON.stringify(aiMetadata) : null,
        sentimentScore || null
      ]
    );

    // Update message count
    await client.query(
      `UPDATE users 
       SET message_count = message_count + 1,
           last_active = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [req.user.userId]
    );

    // Update bot stats
    await client.query(
      `UPDATE bots 
       SET message_count = message_count + 1, 
           last_activity_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [req.params.botId]
    );

    await client.query(
      `UPDATE custom_bots 
       SET updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [req.params.botId]
    );

    // Update conversation tracking
    await client.query(
      `INSERT INTO conversations (bot_id, user_id, last_message_at, message_count)
       VALUES ($1, $2, CURRENT_TIMESTAMP, 1)
       ON CONFLICT (bot_id, user_id) 
       DO UPDATE SET 
         last_message_at = CURRENT_TIMESTAMP,
         message_count = conversations.message_count + 1,
         updated_at = CURRENT_TIMESTAMP`,
      [req.params.botId, req.user.userId]
    );

    await client.query('COMMIT');

    const messageData = result.rows[0];
    messageData.ai_metadata = messageData.ai_metadata ? 
      (typeof messageData.ai_metadata === 'string' ? JSON.parse(messageData.ai_metadata) : messageData.ai_metadata) 
      : null;

    res.status(201).json(messageData);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
});

router.post('/:botId/ai-response', authenticateToken, async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const aiService = await getAIService(req.params.botId, req.user.userId);
    
    if (!aiService) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    // Get AI response
    const response = await aiService.getAIResponse(message, conversationHistory || []);

    res.json({
      message: response.text,
      metadata: response.metadata
    });

  } catch (error) {
    console.error('AI response error:', error);
    res.status(500).json({ error: 'Failed to generate AI response' });
  }
});

router.post('/:botId/initialize', authenticateToken, async (req, res) => {
  const client = await getClient();

  try {
    const { botName, userContext } = req.body;

    await client.query('BEGIN');

    const botCheck = await client.query(
      `SELECT id, name, personality, business_name, category, description
       FROM bots WHERE id = $1 AND user_id = $2
       UNION
       SELECT id, name, personality, business_name, category, description
       FROM custom_bots WHERE id = $1 AND user_id = $2`,
      [req.params.botId, req.user.userId]
    );

    if (botCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }

    const bot = botCheck.rows[0];

    // Check for existing conversation
    const existingConv = await client.query(
      'SELECT id FROM conversations WHERE bot_id = $1 AND user_id = $2',
      [req.params.botId, req.user.userId]
    );

    if (existingConv.rows.length > 0) {
      // Get last few messages for context
      const recentMessages = await client.query(
        `SELECT message, sender, created_at 
         FROM bot_chat_messages 
         WHERE bot_id = $1 AND user_id = $2 
         ORDER BY created_at DESC LIMIT 5`,
        [req.params.botId, req.user.userId]
      );

      await client.query('COMMIT');
      
      return res.json({
        conversationId: existingConv.rows[0].id,
        initialized: true,
        recentMessages: recentMessages.rows.reverse(),
        bot: {
          id: bot.id,
          name: bot.name,
          personality: bot.personality || 'professional',
          businessName: bot.business_name || bot.name,
          category: bot.category
        }
      });
    }

    // Create conversation record
    const convResult = await client.query(
      `INSERT INTO conversations (bot_id, user_id, status, metadata)
       VALUES ($1, $2, 'active', $3)
       RETURNING id`,
      [req.params.botId, req.user.userId, JSON.stringify({ 
        startedAt: new Date().toISOString(),
        userContext: userContext || {}
      })]
    );

    await client.query('COMMIT');

    // Initialize AI service with context
    const aiService = await getAIService(req.params.botId, req.user.userId);
    if (aiService && userContext) {
      aiService.setUserContext(userContext);
    }

    res.status(201).json({
      conversationId: convResult.rows[0].id,
      bot: {
        id: bot.id,
        name: bot.name,
        personality: bot.personality || 'professional',
        businessName: bot.business_name || bot.name,
        category: bot.category,
        description: bot.description
      },
      initialized: true
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Initialize bot chat error:', error);
    res.status(500).json({ error: 'Failed to initialize chat' });
  } finally {
    client.release();
  }
});

router.post('/:botId/messages/:messageId/reaction', authenticateToken, async (req, res) => {
  try {
    const { reaction } = req.body;
    
    if (!reaction || !['helpful', 'not-helpful', 'like', 'dislike'].includes(reaction)) {
      return res.status(400).json({ error: 'Invalid reaction' });
    }

    const result = await query(
      `UPDATE bot_chat_messages 
       SET reactions = COALESCE(reactions, '{}'::jsonb) || jsonb_build_object($1, true),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND bot_id = $3 AND user_id = $4
       RETURNING id, reactions`,
      [reaction, req.params.messageId, req.params.botId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ 
      success: true, 
      reactions: result.rows[0].reactions 
    });

  } catch (error) {
    console.error('Add reaction error:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

router.get('/:botId/suggestions', authenticateToken, async (req, res) => {
  try {
    const aiService = await getAIService(req.params.botId, req.user.userId);
    
    if (!aiService) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    // Get conversation history for context
    const historyResult = await query(
      `SELECT message, sender 
       FROM bot_chat_messages 
       WHERE bot_id = $1 AND user_id = $2 
       ORDER BY created_at DESC LIMIT 10`,
      [req.params.botId, req.user.userId]
    );

    const suggestions = aiService.getSuggestions(historyResult.rows);

    res.json({ suggestions });

  } catch (error) {
    console.error('Get suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

router.delete('/:botId', authenticateToken, async (req, res) => {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const botCheck = await client.query(
      `SELECT id FROM bots WHERE id = $1 AND user_id = $2
       UNION
       SELECT id FROM custom_bots WHERE id = $1 AND user_id = $2`,
      [req.params.botId, req.user.userId]
    );

    if (botCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }

    // Delete messages
    await client.query(
      'DELETE FROM bot_chat_messages WHERE bot_id = $1 AND user_id = $2',
      [req.params.botId, req.user.userId]
    );

    // Delete conversation
    await client.query(
      'DELETE FROM conversations WHERE bot_id = $1 AND user_id = $2',
      [req.params.botId, req.user.userId]
    );

    // Clear cache if exists
    const cacheKey = `${req.params.botId}_${req.user.userId}`;
    if (aiServiceCache.has(cacheKey)) {
      aiServiceCache.delete(cacheKey);
    }

    await client.query('COMMIT');

    res.json({ 
      message: 'Chat history cleared successfully',
      cleared: true 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete bot chat error:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  } finally {
    client.release();
  }
});

module.exports = router;