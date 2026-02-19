-- Drop and recreate subscription_features with proper columns
DROP TABLE IF EXISTS subscription_features CASCADE;

CREATE TABLE subscription_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fix subscriptions table to have start_date (auth.js uses it on signup)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;

-- Fix sessions table to have refresh_token, ip_address, user_agent columns
DROP TABLE IF EXISTS sessions CASCADE;
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fix user_preferences to have correct columns
DROP TABLE IF EXISTS user_preferences CASCADE;
CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notifications BOOLEAN DEFAULT TRUE,
  email_updates BOOLEAN DEFAULT TRUE,
  theme VARCHAR(20) DEFAULT 'light',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fix user_stats to have correct columns
DROP TABLE IF EXISTS user_stats CASCADE;
CREATE TABLE user_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_bots INTEGER DEFAULT 0,
  total_conversations INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add last_login_at to users if missing
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token);
CREATE INDEX IF NOT EXISTS idx_subscription_features_sub_id ON subscription_features(subscription_id);

SELECT 'Neon schema fixed successfully!' as result;