const express = require('express');
const bcrypt = require('bcryptjs');
const { query, getClient } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const isAdmin = async (req, res, next) => {
  try {
    const result = await query('SELECT role FROM users WHERE id = $1', [req.user.userId]);
    if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ error: 'Failed to verify admin status' });
  }
};

const getPlanFeatures = (planType) => {
  const features = {
    free: { advanced_analytics: false, unlimited_bots: false, priority_support: false, custom_branding: false, api_access: false, export_data: false, white_label: false, dedicated_support: false, custom_integrations: false, enterprise_security: false, custom_ai: false, global_cdn: false, multi_tenant: false },
    professional: { advanced_analytics: true, unlimited_bots: true, priority_support: true, custom_branding: true, api_access: true, export_data: true, white_label: false, dedicated_support: false, custom_integrations: true, enterprise_security: false, custom_ai: false, global_cdn: false, multi_tenant: false },
    business: { advanced_analytics: true, unlimited_bots: true, priority_support: true, custom_branding: false, api_access: true, export_data: true, white_label: false, dedicated_support: false, custom_integrations: false, enterprise_security: false, custom_ai: false, global_cdn: false, multi_tenant: false },
    custom: { advanced_analytics: true, unlimited_bots: true, priority_support: true, custom_branding: true, api_access: true, export_data: true, white_label: true, dedicated_support: true, custom_integrations: true, enterprise_security: true, custom_ai: true, global_cdn: true, multi_tenant: true }
  };
  return features[planType] || features.free;
};

router.get('/revenue-test', (req, res) => {
  res.json({ ok: true, message: 'Admin routes working' });
});

router.get('/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        u.id, u.email, u.name, u.phone, u.company, 
        u.profile_picture, u.email_verified, u.role, u.created_at, u.last_login_at,
        s.plan, s.status as subscription_status, s.custom_price,
        sf.advanced_analytics, sf.unlimited_bots, sf.priority_support,
        sf.custom_branding, sf.api_access, sf.export_data, sf.white_label,
        sf.dedicated_support, sf.custom_integrations, sf.enterprise_security,
        sf.custom_ai, sf.global_cdn, sf.multi_tenant,
        up.notifications, up.email_updates, up.theme,
        us.total_bots, us.total_conversations, us.total_messages,
        CASE WHEN s.status = 'active' THEN true ELSE false END as is_active
      FROM users u
      LEFT JOIN subscriptions s ON u.id = s.user_id
      LEFT JOIN subscription_features sf ON s.id = sf.subscription_id
      LEFT JOIN user_preferences up ON u.id = up.user_id
      LEFT JOIN user_stats us ON u.id = us.user_id
      ORDER BY u.created_at DESC`
    );

    const users = result.rows.map(user => ({
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      company: user.company,
      profilePicture: user.profile_picture,
      emailVerified: user.email_verified,
      role: user.role,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      isActive: user.is_active,
      subscription: {
        plan: user.plan,
        status: user.subscription_status,
        customPrice: user.custom_price ? parseFloat(user.custom_price) : null,
        features: {
          advancedAnalytics: user.advanced_analytics,
          unlimitedBots: user.unlimited_bots,
          prioritySupport: user.priority_support,
          customBranding: user.custom_branding,
          apiAccess: user.api_access,
          exportData: user.export_data,
          whiteLabel: user.white_label,
          dedicatedSupport: user.dedicated_support,
          customIntegrations: user.custom_integrations,
          enterpriseSecurity: user.enterprise_security,
          customAI: user.custom_ai,
          globalCDN: user.global_cdn,
          multiTenant: user.multi_tenant
        }
      },
      preferences: { notifications: user.notifications, emailUpdates: user.email_updates, theme: user.theme },
      stats: { totalBots: user.total_bots, totalConversations: user.total_conversations, totalMessages: user.total_messages }
    }));

    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/revenue', authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT s.plan, s.status, s.custom_price
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'active'`
    );

    let totalRevenue = 0;
    const breakdown = {
      free: { count: 0, revenue: 0, pricePerUser: 0 },
      professional: { count: 0, revenue: 0, pricePerUser: 29 },
      business: { count: 0, revenue: 0, pricePerUser: 99 },
      custom: { count: 0, revenue: 0, pricePerUser: null }
    };

    result.rows.forEach(row => {
      const plan = row.plan || 'free';
      if (!breakdown[plan]) return;
      breakdown[plan].count += 1;

      if (plan === 'professional') {
        breakdown.professional.revenue += 29;
        totalRevenue += 29;
      } else if (plan === 'business') {
        breakdown.business.revenue += 99;
        totalRevenue += 99;
      } else if (plan === 'custom' && row.custom_price) {
        const price = parseFloat(row.custom_price);
        breakdown.custom.revenue += price;
        totalRevenue += price;
      }
    });

    res.json({ totalMonthlyRevenue: totalRevenue, breakdown });
  } catch (error) {
    console.error('Revenue error:', error);
    res.status(500).json({ error: 'Failed to calculate revenue' });
  }
});

router.post('/users', authenticateToken, isAdmin, async (req, res) => {
  const client = await getClient();
  try {
    const { email, password, name, phone = '', company = '', role = 'user', plan = 'free', isActive = true, customPrice = null } = req.body;

    if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, and name are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters long' });

    await client.query('BEGIN');

    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, name, phone, company, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, name, phone, company, role, email_verified, created_at`,
      [email.toLowerCase(), passwordHash, name, phone, company, role]
    );
    const user = userResult.rows[0];

    const priceToStore = plan === 'custom' && customPrice ? parseFloat(customPrice) : null;
    const subscriptionResult = await client.query(
      `INSERT INTO subscriptions (user_id, plan, status, custom_price)
       VALUES ($1, $2, $3, $4)
       RETURNING id, plan, status, custom_price`,
      [user.id, plan, isActive ? 'active' : 'inactive', priceToStore]
    );
    const subscription = subscriptionResult.rows[0];

    const features = getPlanFeatures(plan);
    await client.query(
      `INSERT INTO subscription_features (subscription_id, advanced_analytics, unlimited_bots, priority_support, custom_branding, api_access, export_data, white_label, dedicated_support, custom_integrations, enterprise_security, custom_ai, global_cdn, multi_tenant)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [subscription.id, features.advanced_analytics, features.unlimited_bots, features.priority_support, features.custom_branding, features.api_access, features.export_data, features.white_label, features.dedicated_support, features.custom_integrations, features.enterprise_security, features.custom_ai, features.global_cdn, features.multi_tenant]
    );

    await client.query(`INSERT INTO user_preferences (user_id) VALUES ($1)`, [user.id]);
    await client.query(`INSERT INTO user_stats (user_id) VALUES ($1)`, [user.id]);

    await client.query('COMMIT');

    res.status(201).json({
      id: user.id, email: user.email, name: user.name, phone: user.phone,
      company: user.company, role: user.role,
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        customPrice: subscription.custom_price ? parseFloat(subscription.custom_price) : null
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  } finally {
    client.release();
  }
});

router.put('/users/bulk', authenticateToken, isAdmin, async (req, res) => {
  const client = await getClient();
  try {
    const { userIds, action } = req.body;
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'User IDs are required' });
    }

    await client.query('BEGIN');

    switch (action) {
      case 'activate':
        await client.query(
          `UPDATE subscriptions SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE user_id = ANY($1::uuid[])`,
          [userIds]
        );
        break;
      case 'deactivate':
        await client.query(
          `UPDATE subscriptions SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE user_id = ANY($1::uuid[])`,
          [userIds]
        );
        break;
      case 'delete':
        if (userIds.includes(req.user.userId)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
        break;
      default:
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid action' });
    }

    await client.query('COMMIT');
    res.json({ message: 'Bulk action completed successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Bulk action error:', error);
    res.status(500).json({ error: 'Failed to perform bulk action' });
  } finally {
    client.release();
  }
});

router.put('/users/:userId', authenticateToken, isAdmin, async (req, res) => {
  const client = await getClient();
  try {
    const { userId } = req.params;
    const { name, email, phone, company, role, plan, isActive, customPrice = null } = req.body;

    await client.query('BEGIN');

    await client.query(
      `UPDATE users 
       SET name = COALESCE($1, name), email = COALESCE($2, email),
           phone = COALESCE($3, phone), company = COALESCE($4, company),
           role = COALESCE($5, role), updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [name, email?.toLowerCase(), phone, company, role, userId]
    );

    if (plan !== undefined || isActive !== undefined) {
      const subscriptionResult = await client.query(
        `SELECT id FROM subscriptions WHERE user_id = $1`,
        [userId]
      );

      if (subscriptionResult.rows.length > 0) {
        const subscriptionId = subscriptionResult.rows[0].id;
        const priceToStore = plan === 'custom' && customPrice !== null
          ? parseFloat(customPrice)
          : (plan !== 'custom' ? null : undefined);

        if (plan !== undefined) {
          await client.query(
            `UPDATE subscriptions 
             SET plan = $1, status = COALESCE($2, status), custom_price = $3, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $4`,
            [plan, isActive !== undefined ? (isActive ? 'active' : 'inactive') : null, priceToStore ?? null, userId]
          );

          const features = getPlanFeatures(plan);
          await client.query(
            `UPDATE subscription_features 
             SET advanced_analytics=$1, unlimited_bots=$2, priority_support=$3, custom_branding=$4,
                 api_access=$5, export_data=$6, white_label=$7, dedicated_support=$8,
                 custom_integrations=$9, enterprise_security=$10, custom_ai=$11, global_cdn=$12, multi_tenant=$13
             WHERE subscription_id = $14`,
            [features.advanced_analytics, features.unlimited_bots, features.priority_support, features.custom_branding, features.api_access, features.export_data, features.white_label, features.dedicated_support, features.custom_integrations, features.enterprise_security, features.custom_ai, features.global_cdn, features.multi_tenant, subscriptionId]
          );
        } else if (isActive !== undefined) {
          await client.query(
            `UPDATE subscriptions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
            [isActive ? 'active' : 'inactive', userId]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  } finally {
    client.release();
  }
});

router.delete('/users/:userId', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.user.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
    await query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;