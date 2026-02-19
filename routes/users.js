const express = require('express');
const { query } = require('../config/db');
const { authenticateToken } = require('../middleware/auth'); // FIXED: Correct path

const router = express.Router();

// Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        id, email, name, phone, company, profile_picture, 
        email_verified, role, created_at, last_login_at
      FROM users 
      WHERE id = $1`,
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { name, phone, company, profilePicture } = req.body;
    
    const result = await query(
      `UPDATE users 
       SET name = COALESCE($1, name),
           phone = COALESCE($2, phone),
           company = COALESCE($3, company),
           profile_picture = COALESCE($4, profile_picture),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, email, name, phone, company, profile_picture`,
      [name, phone, company, profilePicture, req.user.userId]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update user preferences
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const { notifications, emailUpdates, theme } = req.body;
    
    const result = await query(
      `UPDATE user_preferences 
       SET notifications = COALESCE($1, notifications),
           email_updates = COALESCE($2, email_updates),
           theme = COALESCE($3, theme),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $4
       RETURNING notifications, email_updates, theme`,
      [notifications, emailUpdates, theme, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User preferences not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Get user stats
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT total_bots, total_conversations, total_messages, updated_at
       FROM user_stats 
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User stats not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Update user stats (internal use)
router.put('/stats', authenticateToken, async (req, res) => {
  try {
    const { totalBots, totalConversations, totalMessages } = req.body;
    
    const result = await query(
      `UPDATE user_stats 
       SET total_bots = COALESCE($1, total_bots),
           total_conversations = COALESCE($2, total_conversations),
           total_messages = COALESCE($3, total_messages),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $4
       RETURNING total_bots, total_conversations, total_messages`,
      [totalBots, totalConversations, totalMessages, req.user.userId]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update stats error:', error);
    res.status(500).json({ error: 'Failed to update stats' });
  }
});


router.delete('/account', authenticateToken, async (req, res) => {
  try {
    await query('DELETE FROM users WHERE id = $1', [req.user.userId]);
    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;