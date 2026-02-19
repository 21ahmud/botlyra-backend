-- Business Bots table (for busibots.js)
CREATE TABLE IF NOT EXISTS business_bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id VARCHAR(100) UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  industry VARCHAR(100) DEFAULT '',
  language VARCHAR(50) DEFAULT 'en',
  personality VARCHAR(100) DEFAULT 'professional',
  training_data TEXT DEFAULT '',
  welcome_message TEXT DEFAULT 'Hello! How can I help you today?',
  fallback_message TEXT DEFAULT 'I don''t understand. Could you rephrase?',
  branding JSONB DEFAULT '{}',
  features JSONB DEFAULT '{}',
  security JSONB DEFAULT '{}',
  training_files JSONB DEFAULT '[]',
  data_analysis JSONB,
  deployment_url TEXT,
  api_key VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  conversation_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  user_count INTEGER DEFAULT 0,
  avg_response_time DECIMAL(10,2) DEFAULT 0.8,
  satisfaction_rate DECIMAL(5,2) DEFAULT 92,
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Custom Bots table (for custombots.js)
CREATE TABLE IF NOT EXISTS custom_bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  industry VARCHAR(100) DEFAULT 'technology',
  tier VARCHAR(50) DEFAULT 'professional',
  personality VARCHAR(100) DEFAULT 'professional',
  language VARCHAR(50) DEFAULT 'english',
  features JSONB DEFAULT '{}',
  training_data JSONB DEFAULT '[]',
  configuration JSONB DEFAULT '{}',
  deployment JSONB DEFAULT '{}',
  suggested_questions JSONB DEFAULT '[]',
  data_analysis JSONB,
  stats JSONB DEFAULT '{"totalConversations":0,"totalMessages":0,"uniqueUsers":0}',
  monitoring JSONB DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'training',
  training_progress INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  endpoint TEXT,
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_bots_user_id ON business_bots(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_bots_user_id ON custom_bots(user_id);

SELECT 'Business bots and custom bots tables created!' as result;