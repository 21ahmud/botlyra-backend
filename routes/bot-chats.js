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
  await aiService.initializeModel();
  
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
    
    // Get intent and sentiment for metadata
    const intent = await aiService.understandIntent(message);
    const sentiment = aiService.analyzeSentiment(message);

    res.json({
      message: response,
      metadata: {
        intent,
        sentiment,
        confidence: 0.95,
        model: 'enhanced-ai'
      }
    });

  } catch (error) {
    console.error('AI response error:', error);
    res.status(500).json({ error: 'Failed to generate AI response' });
  }
});

router.post('/:botId/initialize', authenticateToken, async (req, res) => {
  const client = await getClient();

  try {
    const { botName, personality, userContext } = req.body;

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
          personality: bot.personality || personality || 'professional',
          businessName: bot.business_name || bot.name,
          category: bot.category
        }
      });
    }

    // Generate personalized welcome message based on personality and context
    const welcomeTemplates = {
      friendly: {
        morning: `Good morning! ☀️ I'm ${botName || bot.name}, your friendly AI assistant. How can I brighten your day?`,
        afternoon: `Hello there! 👋 I'm ${botName || bot.name}. Ready to help with whatever you need!`,
        evening: `Good evening! 🌙 I'm ${botName || bot.name}. Hope you're having a great day so far!`,
        default: `Hi! 😊 I'm ${botName || bot.name}. So nice to meet you! What can I help you with today?`
      },
      professional: {
        morning: `Good morning. I am ${botName || bot.name}, your AI assistant. How may I assist you today?`,
        afternoon: `Good afternoon. This is ${botName || bot.name}. I'm here to help with your business needs.`,
        evening: `Good evening. I'm ${botName || bot.name}. How can I be of service?`,
        default: `Welcome. I am ${botName || bot.name}, your AI assistant. Please let me know how I can help.`
      },
      witty: {
        morning: `Rise and shine! 🌅 I'm ${botName || bot.name}, ready to tackle your questions with wit and wisdom!`,
        afternoon: `Well, well, well... look who's here! 😎 I'm ${botName || bot.name}. Ready for an interesting conversation?`,
        evening: `The stars are out and so am I! ⭐ I'm ${botName || bot.name}. What's on your mind?`,
        default: `Hey there! 🎯 I'm ${botName || bot.name}. Let's make this conversation memorable!`
      }
    };

    const botPersonality = bot.personality || personality || 'professional';
    const hour = new Date().getHours();
    let timeOfDay = 'default';
    
    if (hour >= 5 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 18) timeOfDay = 'afternoon';
    else if (hour >= 18 || hour < 5) timeOfDay = 'evening';

    const template = welcomeTemplates[botPersonality]?.[timeOfDay] || 
                     welcomeTemplates[botPersonality]?.default ||
                     `Hello! I'm ${botName || bot.name}, your AI assistant. How can I help you today?`;

    // Create conversation record
    const convResult = await client.query(
      `INSERT INTO conversations (bot_id, user_id, status, metadata)
       VALUES ($1, $2, 'active', $3)
       RETURNING id`,
      [req.params.botId, req.user.userId, JSON.stringify({ 
        personality: botPersonality,
        startedAt: new Date().toISOString(),
        userContext: userContext || {}
      })]
    );

    // Insert welcome message
    const messageResult = await client.query(
      `INSERT INTO bot_chat_messages (
        bot_id, user_id, message, sender, ai_metadata, created_at
       )
       VALUES ($1, $2, $3, 'bot', $4, CURRENT_TIMESTAMP)
       RETURNING id, message, created_at`,
      [
        req.params.botId,
        req.user.userId,
        template,
        JSON.stringify({ 
          type: 'welcome', 
          personality: botPersonality,
          confidence: 1.0 
        })
      ]
    );

    await client.query('COMMIT');

    // Initialize AI service with context
    const aiService = await getAIService(req.params.botId, req.user.userId);
    if (aiService && userContext) {
      aiService.setUserContext(userContext);
    }

    res.status(201).json({
      conversationId: convResult.rows[0].id,
      welcomeMessage: messageResult.rows[0],
      bot: {
        id: bot.id,
        name: bot.name,
        personality: botPersonality,
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

router.get('/:botId/summary', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        COUNT(*) as total_messages,
        COUNT(DISTINCT sender) as participants,
        MIN(created_at) as first_message,
        MAX(created_at) as last_message,
        json_agg(DISTINCT sender) as senders,
        AVG(CASE WHEN sentiment_score IS NOT NULL THEN sentiment_score END) as avg_sentiment,
        COUNT(CASE WHEN sender = 'user' THEN 1 END) as user_messages,
        COUNT(CASE WHEN sender = 'bot' THEN 1 END) as bot_messages
      FROM bot_chat_messages
      WHERE bot_id = $1 AND user_id = $2`,
      [req.params.botId, req.user.userId]
    );

    // Get reaction counts
    const reactionsResult = await query(
      `SELECT 
        jsonb_object_keys(reactions) as reaction_type,
        COUNT(*) as count
      FROM bot_chat_messages
      WHERE bot_id = $1 AND user_id = $2 AND reactions IS NOT NULL
      GROUP BY reaction_type`,
      [req.params.botId, req.user.userId]
    );

    const summary = result.rows[0];
    summary.reactions = reactionsResult.rows.reduce((acc, row) => {
      acc[row.reaction_type] = parseInt(row.count);
      return acc;
    }, {});

    res.json(summary);

  } catch (error) {
    console.error('Get chat summary error:', error);
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

router.get('/:botId/suggestions', authenticateToken, async (req, res) => {
  try {
    const botCheck = await query(
      `SELECT category, business_type FROM (
         SELECT category, business_type FROM bots WHERE id = $1
         UNION
         SELECT category, business_type FROM custom_bots WHERE id = $1
       ) b`,
      [req.params.botId]
    );

    if (botCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const bot = botCheck.rows[0];
    const category = bot.category || bot.business_type || 'general';

    const suggestionsByCategory = {
      general: [
        "What services do you offer?",
        "How can you help me?",
        "Tell me about your company",
        "What are your hours?",
        "How do I contact support?"
      ],
      business: [
        "What's your pricing?",
        "Do you offer consultations?",
        "Can you provide case studies?",
        "What industries do you serve?",
        "Do you have a free trial?"
      ],
      technology: [
        "What tech stack do you use?",
        "Do you offer API access?",
        "Is it secure?",
        "Can you integrate with other tools?",
        "What's your uptime guarantee?"
      ],
      marketing: [
        "What marketing services do you offer?",
        "How do you measure ROI?",
        "Can you help with SEO?",
        "Do you manage social media?",
        "What's your content strategy?"
      ],
      ecommerce: [
        "How do I set up a store?",
        "What payment methods do you accept?",
        "Do you handle shipping?",
        "Can you manage inventory?",
        "What's your return policy?"
      ],
      consulting: [
        "What's your consulting process?",
        "How long are engagements?",
        "What's your success rate?",
        "Can you provide references?",
        "Do you offer ongoing support?"
      ]
    };

    const suggestions = suggestionsByCategory[category.toLowerCase()] || suggestionsByCategory.general;

    // Get popular questions from this bot's history
    const popularQuestions = await query(
      `SELECT message, COUNT(*) as frequency
       FROM bot_chat_messages
       WHERE bot_id = $1 AND sender = 'user'
       GROUP BY message
       ORDER BY frequency DESC
       LIMIT 3`,
      [req.params.botId]
    );

    const popular = popularQuestions.rows.map(q => q.message);

    res.json({
      categoryBased: suggestions,
      popular: popular,
      all: [...new Set([...suggestions, ...popular])].slice(0, 8)
    });

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

router.post('/:botId/export', authenticateToken, async (req, res) => {
  try {
    const { format = 'json' } = req.body;

    const messages = await query(
      `SELECT message, sender, ai_metadata, sentiment_score, created_at
       FROM bot_chat_messages
       WHERE bot_id = $1 AND user_id = $2
       ORDER BY created_at ASC`,
      [req.params.botId, req.user.userId]
    );

    if (format === 'csv') {
      const csv = messages.rows.map(row => {
        return `${row.created_at},${row.sender},"${row.message.replace(/"/g, '""')}",${row.sentiment_score || ''}`;
      }).join('\n');

      const header = 'Timestamp,Sender,Message,Sentiment Score\n';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=chat-${req.params.botId}.csv`);
      res.send(header + csv);
    } else {
      res.json({
        botId: req.params.botId,
        userId: req.user.userId,
        exportedAt: new Date().toISOString(),
        totalMessages: messages.rows.length,
        messages: messages.rows
      });
    }

  } catch (error) {
    console.error('Export chat error:', error);
    res.status(500).json({ error: 'Failed to export chat' });
  }
});

module.exports = router;