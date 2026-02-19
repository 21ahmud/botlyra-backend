const express = require('express');
const { query, getClient } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get messages for a bot chat
router.get('/:botId', authenticateToken, async (req, res) => {
  try {
    // Verify bot ownership
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
      `SELECT id, bot_id, user_id, message, sender, 
              ai_metadata, created_at
       FROM bot_chat_messages
       WHERE bot_id = $1 AND user_id = $2
       ORDER BY created_at ASC`,
      [req.params.botId, req.user.userId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get bot chat messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Send a message
router.post('/:botId/messages', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    const { message, sender, aiMetadata } = req.body;
    
    if (!message || !sender) {
      return res.status(400).json({ error: 'Message and sender are required' });
    }
    
    if (!['user', 'bot'].includes(sender)) {
      return res.status(400).json({ error: 'Invalid sender type' });
    }
    
    await client.query('BEGIN');
    
    // Verify bot ownership
    const botCheck = await query(
  `SELECT id FROM bots WHERE id = $1 AND user_id = $2
   UNION
   SELECT id FROM custom_bots WHERE id = $1 AND user_id = $2`,
  [req.params.botId, req.user.userId]
);
    
    if (botCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const result = await client.query(
      `INSERT INTO bot_chat_messages (
        bot_id, user_id, message, sender, ai_metadata
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, bot_id, user_id, message, sender, 
                ai_metadata, created_at`,
      [
        req.params.botId,
        req.user.userId,
        message,
        sender,
        aiMetadata ? JSON.stringify(aiMetadata) : null
      ]
    );
    
    // Update bot message count and last activity
    await client.query(
      `UPDATE bots 
       SET message_count = message_count + 1,
           last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [req.params.botId]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json(result.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
});

// Initialize bot chat with welcome message
router.post('/:botId/initialize', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    const { botName } = req.body;
    
    await client.query('BEGIN');
    
    // Verify bot ownership
    const botCheck = await client.query(
      'SELECT id, name FROM bots WHERE id = $1 AND user_id = $2',
      [req.params.botId, req.user.userId]
    );
    
    if (botCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const bot = botCheck.rows[0];
    
    // Check if already initialized
    const existingMessages = await client.query(
      'SELECT id FROM bot_chat_messages WHERE bot_id = $1 AND user_id = $2 LIMIT 1',
      [req.params.botId, req.user.userId]
    );
    
    if (existingMessages.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ message: 'Chat already initialized' });
    }
    
    // Create welcome message
    const result = await client.query(
      `INSERT INTO bot_chat_messages (
        bot_id, user_id, message, sender, ai_metadata
      )
      VALUES ($1, $2, $3, 'bot', $4)
      RETURNING id, bot_id, user_id, message, sender, 
                ai_metadata, created_at`,
      [
        req.params.botId,
        req.user.userId,
        `Hello! I'm ${botName || bot.name}, your AI assistant. How can I help you today?`,
        JSON.stringify({ model: 'custom', confidence: 1.0, intent: 'greeting' })
      ]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json(result.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Initialize bot chat error:', error);
    res.status(500).json({ error: 'Failed to initialize chat' });
  } finally {
    client.release();
  }
});

// Delete all messages for a bot chat
router.delete('/:botId', authenticateToken, async (req, res) => {
  try {
    // Verify bot ownership
    const botCheck = await query(
  `SELECT id FROM bots WHERE id = $1 AND user_id = $2
   UNION
   SELECT id FROM custom_bots WHERE id = $1 AND user_id = $2`,
  [req.params.botId, req.user.userId]
);
    
    if (botCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    await query(
      'DELETE FROM bot_chat_messages WHERE bot_id = $1 AND user_id = $2',
      [req.params.botId, req.user.userId]
    );
    
    res.json({ message: 'Chat history cleared' });
  } catch (error) {
    console.error('Delete bot chat error:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

module.exports = router;