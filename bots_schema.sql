CREATE TABLE bots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  business_info TEXT DEFAULT '',
  faq TEXT DEFAULT '',
  language VARCHAR(50) DEFAULT 'en',
  category VARCHAR(100) DEFAULT '',
  personality VARCHAR(100) DEFAULT '',

  
  branding JSONB DEFAULT jsonb_build_object(
    'primaryColor', '#000000',
    'logo', NULL,
    'welcomeMessage', 'Hello! How can I help you today?'
  ),


  features JSONB DEFAULT jsonb_build_object(
    'voiceAssistant', FALSE,
    'analytics', FALSE,
    'leadCollection', FALSE,
    'multiLanguage', FALSE,
    'customBranding', FALSE,
    'apiAccess', FALSE
  ),

  type VARCHAR(50) DEFAULT 'quick' CHECK (type IN ('quick', 'professional')),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),

  conversation_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  user_count INTEGER DEFAULT 0,

  satisfaction_rate NUMERIC(5,2) DEFAULT 0.00,
  avg_response_time NUMERIC(10,2) DEFAULT 0.00,
  conversion_rate NUMERIC(5,2) DEFAULT 0.00,

  impact VARCHAR(100) DEFAULT '',
  impact_percent NUMERIC(5,2) DEFAULT 0.00,
  avg_time VARCHAR(100) DEFAULT '',

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


CREATE INDEX idx_bots_user_id ON bots(user_id);
CREATE INDEX idx_bots_status ON bots(status);
CREATE INDEX idx_bots_category ON bots(category);
CREATE INDEX idx_bots_language ON bots(language);
CREATE INDEX idx_bots_type ON bots(type);

CREATE OR REPLACE FUNCTION update_last_activity()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_activity = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_last_activity
BEFORE UPDATE ON bots
FOR EACH ROW
EXECUTE FUNCTION update_last_activity();

DO $$
BEGIN
  RAISE NOTICE '✅ Bots table created successfully with all fields and relations!';
END $$;
