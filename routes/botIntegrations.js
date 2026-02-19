const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

router.get('/bot-integrations', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const result = await pool.query(
      'SELECT * FROM bot_integrations WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching integrations:', error);
    res.status(500).json({ error: 'Failed to fetch integrations' });
  }
});

router.post('/bot-integrations', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { bot_id, integration_name, status, integration_config } = req.body;
    
    if (!bot_id || !integration_name) {
      return res.status(400).json({ error: 'bot_id and integration_name are required' });
    }
    
    const result = await pool.query(
      `INSERT INTO bot_integrations 
       (bot_id, user_id, integration_name, status, integration_config) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (bot_id, integration_name) 
       DO UPDATE SET 
         status = $4, 
         integration_config = $5,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [bot_id, userId, integration_name, status || 'active', integration_config || {}]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating integration:', error);
    res.status(500).json({ error: 'Failed to create integration' });
  }
});

router.delete('/bot-integrations/by-name/:name', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const integrationName = req.params.name;
    
    const result = await pool.query(
      'DELETE FROM bot_integrations WHERE user_id = $1 AND integration_name = $2 RETURNING *',
      [userId, integrationName]
    );
    
    res.json({ 
      message: 'Integration disconnected successfully',
      deleted: result.rowCount
    });
  } catch (error) {
    console.error('Error disconnecting integration:', error);
    res.status(500).json({ error: 'Failed to disconnect integration' });
  }
});

router.delete('/bot-integrations/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const integrationId = req.params.id;
    
    const result = await pool.query(
      'DELETE FROM bot_integrations WHERE id = $1 AND user_id = $2 RETURNING *',
      [integrationId, userId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Integration not found' });
    }
    
    res.json({ message: 'Integration deleted successfully' });
  } catch (error) {
    console.error('Error deleting integration:', error);
    res.status(500).json({ error: 'Failed to delete integration' });
  }
});

router.get('/bot-integrations/bot/:botId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const botId = req.params.botId;
    
    const result = await pool.query(
      'SELECT * FROM bot_integrations WHERE user_id = $1 AND bot_id = $2',
      [userId, botId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bot integrations:', error);
    res.status(500).json({ error: 'Failed to fetch bot integrations' });
  }
});

router.put('/bot-integrations/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const integrationId = req.params.id;
    const { status, integration_config } = req.body;
    
    const result = await pool.query(
      `UPDATE bot_integrations 
       SET status = COALESCE($1, status),
           integration_config = COALESCE($2, integration_config),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [status, integration_config, integrationId, userId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Integration not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating integration:', error);
    res.status(500).json({ error: 'Failed to update integration' });
  }
});

router.get('/bot-integrations/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const result = await pool.query(
      `SELECT 
         COUNT(DISTINCT integration_name) as total_integrations,
         COUNT(DISTINCT bot_id) as total_connected_bots,
         COUNT(*) as total_connections,
         integration_name,
         COUNT(*) as connection_count
       FROM bot_integrations 
       WHERE user_id = $1 AND status = 'active'
       GROUP BY integration_name`,
      [userId]
    );
    
    const stats = {
      totalIntegrations: result.rows.length,
      totalConnectedBots: result.rows.length > 0 ? result.rows[0].total_connected_bots : 0,
      totalConnections: result.rows.reduce((sum, row) => sum + parseInt(row.connection_count), 0),
      integrations: result.rows
    };
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching integration stats:', error);
    res.status(500).json({ error: 'Failed to fetch integration stats' });
  }
});

module.exports = router;