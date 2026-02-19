const express = require('express');
const { query, getClient } = require('../config/db');
const { authenticateToken } = require('../middleware/auth'); // FIXED: Changed from ../../ to ../

const router = express.Router();

// Get plan features helper
const getPlanFeatures = (plan) => {
  const features = {
    free: {
      advanced_analytics: false,
      unlimited_bots: false,
      priority_support: false,
      custom_branding: false,
      api_access: false,
      export_data: false,
      white_label: false,
      dedicated_support: false,
      custom_integrations: false,
      enterprise_security: false,
      custom_ai: false,
      global_cdn: false,
      multi_tenant: false
    },
    business: {
      advanced_analytics: true,
      unlimited_bots: true,
      priority_support: true,
      custom_branding: false,
      api_access: true,
      export_data: true,
      white_label: false,
      dedicated_support: false,
      custom_integrations: false,
      enterprise_security: false,
      custom_ai: false,
      global_cdn: false,
      multi_tenant: false
    },
    professional: {
      advanced_analytics: true,
      unlimited_bots: true,
      priority_support: true,
      custom_branding: true,
      api_access: true,
      export_data: true,
      white_label: false,
      dedicated_support: false,
      custom_integrations: true,
      enterprise_security: false,
      custom_ai: false,
      global_cdn: false,
      multi_tenant: false
    },
    custom: {
      advanced_analytics: true,
      unlimited_bots: true,
      priority_support: true,
      custom_branding: true,
      api_access: true,
      export_data: true,
      white_label: true,
      dedicated_support: true,
      custom_integrations: true,
      enterprise_security: true,
      custom_ai: true,
      global_cdn: true,
      multi_tenant: true
    }
  };
  
  return features[plan] || features.free;
};

// Get current subscription
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        s.id, s.plan, s.status, s.start_date, s.end_date,
        sf.advanced_analytics, sf.unlimited_bots, sf.priority_support,
        sf.custom_branding, sf.api_access, sf.export_data, sf.white_label,
        sf.dedicated_support, sf.custom_integrations, sf.enterprise_security,
        sf.custom_ai, sf.global_cdn, sf.multi_tenant
      FROM subscriptions s
      LEFT JOIN subscription_features sf ON s.id = sf.subscription_id
      WHERE s.user_id = $1`,
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const subscription = result.rows[0];
    
    res.json({
      id: subscription.id,
      plan: subscription.plan,
      status: subscription.status,
      startDate: subscription.start_date,
      endDate: subscription.end_date,
      features: {
        advancedAnalytics: subscription.advanced_analytics,
        unlimitedBots: subscription.unlimited_bots,
        prioritySupport: subscription.priority_support,
        customBranding: subscription.custom_branding,
        apiAccess: subscription.api_access,
        exportData: subscription.export_data,
        whiteLabel: subscription.white_label,
        dedicatedSupport: subscription.dedicated_support,
        customIntegrations: subscription.custom_integrations,
        enterpriseSecurity: subscription.enterprise_security,
        customAI: subscription.custom_ai,
        globalCDN: subscription.global_cdn,
        multiTenant: subscription.multi_tenant
      }
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// Upgrade/Change subscription plan
router.put('/upgrade', authenticateToken, async (req, res) => {
  const client = await getClient();
  
  try {
    const { plan } = req.body;
    
    if (!['free', 'business', 'professional', 'custom'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    
    await client.query('BEGIN');
    
    // Get current subscription
    const subscriptionResult = await client.query(
      'SELECT id FROM subscriptions WHERE user_id = $1',
      [req.user.userId]
    );
    
    if (subscriptionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const subscriptionId = subscriptionResult.rows[0].id;
    
    // Update subscription plan
    await client.query(
      `UPDATE subscriptions 
       SET plan = $1, 
           status = 'active',
           start_date = CURRENT_TIMESTAMP,
           end_date = CASE 
             WHEN $1 IN ('professional', 'custom') THEN NULL 
             ELSE CURRENT_TIMESTAMP 
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [plan, subscriptionId]
    );
    
    // Update subscription features
    const features = getPlanFeatures(plan);
    await client.query(
      `UPDATE subscription_features 
       SET advanced_analytics = $1,
           unlimited_bots = $2,
           priority_support = $3,
           custom_branding = $4,
           api_access = $5,
           export_data = $6,
           white_label = $7,
           dedicated_support = $8,
           custom_integrations = $9,
           enterprise_security = $10,
           custom_ai = $11,
           global_cdn = $12,
           multi_tenant = $13
       WHERE subscription_id = $14`,
      [
        features.advanced_analytics,
        features.unlimited_bots,
        features.priority_support,
        features.custom_branding,
        features.api_access,
        features.export_data,
        features.white_label,
        features.dedicated_support,
        features.custom_integrations,
        features.enterprise_security,
        features.custom_ai,
        features.global_cdn,
        features.multi_tenant,
        subscriptionId
      ]
    );
    
    await client.query('COMMIT');
    
    res.json({
      message: 'Subscription upgraded successfully',
      plan,
      features
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Upgrade subscription error:', error);
    res.status(500).json({ error: 'Failed to upgrade subscription' });
  } finally {
    client.release();
  }
});

// Cancel subscription
router.delete('/cancel', authenticateToken, async (req, res) => {
  try {
    await query(
      `UPDATE subscriptions 
       SET status = 'cancelled',
           end_date = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    res.json({ message: 'Subscription cancelled successfully' });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Reactivate subscription
router.post('/reactivate', authenticateToken, async (req, res) => {
  try {
    await query(
      `UPDATE subscriptions 
       SET status = 'active',
           end_date = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    res.json({ message: 'Subscription reactivated successfully' });
  } catch (error) {
    console.error('Reactivate subscription error:', error);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});

module.exports = router;