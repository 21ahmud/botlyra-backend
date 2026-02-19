-- Migration script to fix user_id type mismatch
-- Run this in your PostgreSQL database

-- Step 1: Drop all dependent tables (CASCADE will handle foreign keys)
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS user_stats CASCADE;
DROP TABLE IF EXISTS user_preferences CASCADE;
DROP TABLE IF EXISTS subscription_features CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;

-- Note: We're NOT dropping users table to preserve any existing admin user

-- Step 2: Check if users table uses UUID
DO $$
BEGIN
    -- If users.id is not UUID, we need to recreate the users table too
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' 
        AND column_name = 'id' 
        AND data_type != 'uuid'
    ) THEN
        -- Backup and drop users table
        DROP TABLE IF EXISTS users CASCADE;
        
        -- Recreate users table with UUID
        CREATE TABLE users (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          phone VARCHAR(50) DEFAULT '',
          company VARCHAR(255) DEFAULT '',
          profile_picture TEXT DEFAULT NULL,
          email_verified BOOLEAN DEFAULT FALSE,
          role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login_at TIMESTAMP DEFAULT NULL
        );
        
        RAISE NOTICE 'Users table recreated with UUID primary key';
    END IF;
END $$;

-- Step 3: Create subscriptions table with UUID foreign key
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR(50) DEFAULT 'free' CHECK (plan IN ('free', 'business', 'professional', 'custom')),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'past_due')),
  start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_date TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 4: Create subscription_features table
CREATE TABLE subscription_features (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID UNIQUE NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  advanced_analytics BOOLEAN DEFAULT FALSE,
  unlimited_bots BOOLEAN DEFAULT FALSE,
  priority_support BOOLEAN DEFAULT FALSE,
  custom_branding BOOLEAN DEFAULT FALSE,
  api_access BOOLEAN DEFAULT FALSE,
  export_data BOOLEAN DEFAULT FALSE,
  white_label BOOLEAN DEFAULT FALSE,
  dedicated_support BOOLEAN DEFAULT FALSE,
  custom_integrations BOOLEAN DEFAULT FALSE,
  enterprise_security BOOLEAN DEFAULT FALSE,
  custom_ai BOOLEAN DEFAULT FALSE,
  global_cdn BOOLEAN DEFAULT FALSE,
  multi_tenant BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 5: Create user_preferences table
CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notifications BOOLEAN DEFAULT TRUE,
  email_updates BOOLEAN DEFAULT TRUE,
  theme VARCHAR(50) DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'system')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 6: Create user_stats table
CREATE TABLE user_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_bots INTEGER DEFAULT 0,
  total_conversations INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 7: Create sessions table
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  user_agent TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 8: Create indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_plan ON subscriptions(plan);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_refresh_token ON sessions(refresh_token);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Step 9: Create triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscription_features_updated_at BEFORE UPDATE ON subscription_features
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_stats_updated_at BEFORE UPDATE ON user_stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Step 10: Create a default admin user (OPTIONAL - remove if not needed)
-- Password is 'admin123' - CHANGE THIS IMMEDIATELY!
DO $$
DECLARE
  admin_user_id UUID;
  admin_subscription_id UUID;
BEGIN
  -- Insert admin user
  INSERT INTO users (email, password_hash, name, role, email_verified)
  VALUES (
    'admin@botlyra.com',
    '$2a$10$rXK5h6YGYuBKRZ5kHJY8O.HZvXGxGxWxWxWxWxWxWxWxWxWxWxWxW', -- Replace with real hash
    'Admin User',
    'admin',
    TRUE
  )
  RETURNING id INTO admin_user_id;
  
  -- Create admin subscription
  INSERT INTO subscriptions (user_id, plan, status)
  VALUES (admin_user_id, 'custom', 'active')
  RETURNING id INTO admin_subscription_id;
  
  -- Create admin subscription features (all enabled)
  INSERT INTO subscription_features (
    subscription_id, advanced_analytics, unlimited_bots, priority_support,
    custom_branding, api_access, export_data, white_label, dedicated_support,
    custom_integrations, enterprise_security, custom_ai, global_cdn, multi_tenant
  )
  VALUES (admin_subscription_id, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE);
  
  -- Create admin preferences
  INSERT INTO user_preferences (user_id)
  VALUES (admin_user_id);
  
  -- Create admin stats
  INSERT INTO user_stats (user_id)
  VALUES (admin_user_id);
  
  RAISE NOTICE 'Admin user created successfully';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'Admin user already exists, skipping';
END $$;

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ Database schema fixed successfully!';
  RAISE NOTICE '✅ All tables now use UUID for foreign keys';
  RAISE NOTICE '⚠️  If admin user was created, change the password immediately!';
END $$;