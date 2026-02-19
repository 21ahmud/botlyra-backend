const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, getClient } = require('../config/db');

const router = express.Router();

if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  console.error('JWT_SECRET and JWT_REFRESH_SECRET must be set in .env file');
  process.exit(1);
}

const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  
  const refreshToken = jwt.sign(
    { userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  
  return { accessToken, refreshToken };
};

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

const setAuthCookies = (res, accessToken, refreshToken) => {
  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
  };

  res.cookie('accessToken', accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000,
  });
  
  res.cookie('refreshToken', refreshToken, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const clearAuthCookies = (res) => {
  const options = { httpOnly: true, secure: true, sameSite: 'none' };
  res.clearCookie('accessToken', options);
  res.clearCookie('refreshToken', options);
};

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const token = headerToken || req.cookies.accessToken;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
};

router.post('/signup', async (req, res) => {
  let client;
  
  try {
    const { email, password, name, phone = '', company = '', plan = 'free' } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }
    
    client = await getClient();
    await client.query('BEGIN');
    
    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, name, phone, company, role)
       VALUES ($1, $2, $3, $4, $5, 'user')
       RETURNING id, email, name, phone, company, role, email_verified, created_at`,
      [email.toLowerCase(), passwordHash, name, phone, company]
    );
    
    const user = userResult.rows[0];
    
    const subscriptionResult = await client.query(
      `INSERT INTO subscriptions (user_id, plan, status)
       VALUES ($1, $2, 'active')
       RETURNING id, plan, status, start_date`,
      [user.id, plan]
    );
    
    const subscription = subscriptionResult.rows[0];
    
    const features = getPlanFeatures(plan);
    await client.query(
      `INSERT INTO subscription_features (
        subscription_id, advanced_analytics, unlimited_bots, priority_support,
        custom_branding, api_access, export_data, white_label, dedicated_support,
        custom_integrations, enterprise_security, custom_ai, global_cdn, multi_tenant
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        subscription.id,
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
        features.multi_tenant
      ]
    );
    
    await client.query(
      `INSERT INTO user_preferences (user_id, notifications, email_updates, theme) 
       VALUES ($1, TRUE, TRUE, 'light')`,
      [user.id]
    );
    
    await client.query(
      `INSERT INTO user_stats (user_id, total_bots, total_conversations, total_messages) 
       VALUES ($1, 0, 0, 0)`,
      [user.id]
    );
    
    await client.query('COMMIT');
    
    const { accessToken, refreshToken } = generateTokens(user.id);
    
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO sessions (user_id, refresh_token, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, expiresAt, req.ip, req.get('user-agent')]
    );
    
    setAuthCookies(res, accessToken, refreshToken);
    
    res.status(201).json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        company: user.company,
        role: user.role,
        emailVerified: user.email_verified
      },
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        features
      }
    });
    
  } catch (error) {
    console.error('Signup error:', error);
    if (client) await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to create account' });
  } finally {
    if (client) client.release();
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const result = await query(
      `SELECT 
        u.id, u.email, u.password_hash, u.name, u.phone, u.company, 
        u.profile_picture, u.email_verified, u.role,
        s.plan, s.status,
        sf.advanced_analytics, sf.unlimited_bots, sf.priority_support,
        sf.custom_branding, sf.api_access, sf.export_data, sf.white_label,
        sf.dedicated_support, sf.custom_integrations, sf.enterprise_security,
        sf.custom_ai, sf.global_cdn, sf.multi_tenant,
        up.notifications, up.email_updates, up.theme,
        us.total_bots, us.total_conversations, us.total_messages
      FROM users u
      LEFT JOIN subscriptions s ON u.id = s.user_id
      LEFT JOIN subscription_features sf ON s.id = sf.subscription_id
      LEFT JOIN user_preferences up ON u.id = up.user_id
      LEFT JOIN user_stats us ON u.id = us.user_id
      WHERE u.email = $1`,
      [email.toLowerCase()]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const user = result.rows[0];
    
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    await query(
      'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    const { accessToken, refreshToken } = generateTokens(user.id);
    
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO sessions (user_id, refresh_token, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, expiresAt, req.ip, req.get('user-agent')]
    );
    
    setAuthCookies(res, accessToken, refreshToken);
    
    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        company: user.company,
        profilePicture: user.profile_picture,
        emailVerified: user.email_verified,
        role: user.role
      },
      subscription: {
        plan: user.plan,
        status: user.status,
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
      preferences: {
        notifications: user.notifications,
        emailUpdates: user.email_updates,
        theme: user.theme
      },
      stats: {
        totalBots: user.total_bots,
        totalConversations: user.total_conversations,
        totalMessages: user.total_messages
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    
    if (refreshToken) {
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      await query(
        'DELETE FROM sessions WHERE user_id = $1 AND refresh_token = $2',
        [decoded.userId, refreshToken]
      );
    }
    
    clearAuthCookies(res);
    res.json({ message: 'Logged out successfully' });
    
  } catch (error) {
    console.error('Logout error:', error);
    clearAuthCookies(res);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        u.id, u.email, u.name, u.phone, u.company, 
        u.profile_picture, u.email_verified, u.role, u.created_at,
        s.plan, s.status,
        sf.advanced_analytics, sf.unlimited_bots, sf.priority_support,
        sf.custom_branding, sf.api_access, sf.export_data, sf.white_label,
        sf.dedicated_support, sf.custom_integrations, sf.enterprise_security,
        sf.custom_ai, sf.global_cdn, sf.multi_tenant,
        up.notifications, up.email_updates, up.theme,
        us.total_bots, us.total_conversations, us.total_messages
      FROM users u
      LEFT JOIN subscriptions s ON u.id = s.user_id
      LEFT JOIN subscription_features sf ON s.id = sf.subscription_id
      LEFT JOIN user_preferences up ON u.id = up.user_id
      LEFT JOIN user_stats us ON u.id = us.user_id
      WHERE u.id = $1`,
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        company: user.company,
        profilePicture: user.profile_picture,
        emailVerified: user.email_verified,
        role: user.role,
        createdAt: user.created_at
      },
      subscription: {
        plan: user.plan,
        status: user.status,
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
      preferences: {
        notifications: user.notifications,
        emailUpdates: user.email_updates,
        theme: user.theme
      },
      stats: {
        totalBots: user.total_bots,
        totalConversations: user.total_conversations,
        totalMessages: user.total_messages
      }
    });
    
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user data' });
  }
});

module.exports = router;
module.exports.authenticateToken = authenticateToken;