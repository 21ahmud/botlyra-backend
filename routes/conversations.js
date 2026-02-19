// routes/conversations.js
const express = require('express');
const { query, getClient } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all conversations for a bot
router.get('/bot/:botId', authenticateToken, async (req, res) => {
  try {
    // Verify bot ownership
    const botCheck = await query(
      'SELECT id FROM bots WHERE id = $1 AND user_id = $2',
      [req.params.botId, req.user.userId]
    );
    
    if (botCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const result = await query(
      `SELECT 
        c.id, c.bot_id, c.user_name, c.user_email, c.user_phone,
        c.status, c.rating, c.created_at, c.updated_at,
        COUNT(m.id) as message_count,
        MAX(m.created_at) as last_message_at
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE c.bot_id = $1
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
      [req.params.botId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// Get single conversation with messages
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // Get conversation
    const convResult = await query(
      `SELECT c.*, b.user_id as bot_owner_id
       FROM conversations c
       JOIN bots b ON c.bot_id = b.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    
    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    const conversation = convResult.rows[0];
    
    // Verify ownership
    if (conversation.bot_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Get messages
    const messagesResult = await query(
      `SELECT 
        id, conversation_id, sender, content, attachments,
        created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC`,
      [req.params.id]
    );
    
    res.json({
      ...conversation,
      messages: messagesResult.rows
    });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// Create new conversation
router.post('/', async (req, res) => {
  const client = await getClient();
  
  try {
    const { botId, userName, userEmail, userPhone } = req.body;
    
    if (!botId) {
      return res.status(400).json({ error: 'Bot ID is required' });
    }
    
    await client.query('BEGIN');
    
    // Check if bot exists and is active
    const botResult = await client.query(
      'SELECT id, user_id FROM bots WHERE id = $1 AND status = $2',
      [botId, 'active']
    );
    
    if (botResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bot not found or inactive' });
    }
    
    // Create conversation
    const convResult = await client.query(
      `INSERT INTO conversations (
        bot_id, user_name, user_email, user_phone, status
      )
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING id, bot_id, user_name, user_email, user_phone, status, created_at`,
      [botId, userName || 'Anonymous', userEmail || null, userPhone || null]
    );
    
    // Update bot stats
    await client.query(
      `UPDATE bots 
       SET conversation_count = conversation_count + 1,
           last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [botId]
    );
    
    // Update user stats
    await client.query(
      `UPDATE user_stats 
       SET total_conversations = total_conversations + 1
       WHERE user_id = $1`,
      [botResult.rows[0].user_id]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json(convResult.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  } finally {
    client.release();
  }
});

// Add message to conversation
router.post('/:id/messages', async (req, res) => {
  const client = await getClient();
  
  try {
    const { sender, content, attachments } = req.body;
    
    if (!sender || !content) {
      return res.status(400).json({ error: 'Sender and content are required' });
    }
    
    if (!['user', 'bot'].includes(sender)) {
      return res.status(400).json({ error: 'Invalid sender type' });
    }
    
    await client.query('BEGIN');
    
    // Check if conversation exists
    const convResult = await client.query(
      `SELECT c.id, c.bot_id, b.user_id as bot_owner_id
       FROM conversations c
       JOIN bots b ON c.bot_id = b.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    
    if (convResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    const conversation = convResult.rows[0];
    
    // Create message
    const messageResult = await client.query(
      `INSERT INTO messages (
        conversation_id, sender, content, attachments
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id, conversation_id, sender, content, attachments, created_at`,
      [req.params.id, sender, content, attachments ? JSON.stringify(attachments) : null]
    );
    
    // Update conversation
    await client.query(
      `UPDATE conversations 
       SET updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [req.params.id]
    );
    
    // Update bot stats
    await client.query(
      `UPDATE bots 
       SET message_count = message_count + 1,
           last_activity_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [conversation.bot_id]
    );
    
    // Update user stats
    await client.query(
      `UPDATE user_stats 
       SET total_messages = total_messages + 1
       WHERE user_id = $1`,
      [conversation.bot_owner_id]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json(messageResult.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create message error:', error);
    res.status(500).json({ error: 'Failed to create message' });
  } finally {
    client.release();
  }
});

// Update conversation status
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['active', 'closed', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    // Verify ownership
    const checkResult = await query(
      `SELECT c.id
       FROM conversations c
       JOIN bots b ON c.bot_id = b.id
       WHERE c.id = $1 AND b.user_id = $2`,
      [req.params.id, req.user.userId]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    await query(
      `UPDATE conversations 
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [status, req.params.id]
    );
    
    res.json({ message: 'Status updated' });
  } catch (error) {
    console.error('Update conversation status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Rate conversation
router.post('/:id/rate', async (req, res) => {
  try {
    const { rating } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    
    const result = await query(
      `UPDATE conversations 
       SET rating = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, rating`,
      [rating, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Rate conversation error:', error);
    res.status(500).json({ error: 'Failed to rate conversation' });
  }
});

// Delete conversation
router.delete('/:id', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    // Verify ownership and get bot_id
    const checkResult = await client.query(
      `SELECT c.id, c.bot_id, b.user_id as bot_owner_id
       FROM conversations c
       JOIN bots b ON c.bot_id = b.id
       WHERE c.id = $1 AND b.user_id = $2`,
      [req.params.id, req.user.userId]
    );
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    const conversation = checkResult.rows[0];
    
    // Delete messages
    await client.query(
      'DELETE FROM messages WHERE conversation_id = $1',
      [req.params.id]
    );
    
    // Delete conversation
    await client.query(
      'DELETE FROM conversations WHERE id = $1',
      [req.params.id]
    );
    
    // Update bot stats
    await client.query(
      `UPDATE bots 
       SET conversation_count = GREATEST(conversation_count - 1, 0)
       WHERE id = $1`,
      [conversation.bot_id]
    );
    
    // Update user stats
    await client.query(
      `UPDATE user_stats 
       SET total_conversations = GREATEST(total_conversations - 1, 0)
       WHERE user_id = $1`,
      [conversation.bot_owner_id]
    );
    
    await client.query('COMMIT');
    
    res.json({ message: 'Conversation deleted successfully' });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  } finally {
    client.release();
  }
});

module.exports = router;