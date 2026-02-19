from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import json
import sqlite3
from datetime import datetime
import re
import nltk
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
import pickle
import os
from transformers import pipeline, AutoTokenizer, AutoModel
import torch

try:
    nltk.download('punkt', quiet=True)
    nltk.download('stopwords', quiet=True)
    nltk.download('vader_lexicon', quiet=True)
except Exception as e:
    pass

app = Flask(__name__)
CORS(app)

class CustomBusinessAI:
    def __init__(self):
        self.models = {}
        self.vectorizers = {}
        self.business_contexts = {}
        self.init_database()
        self.load_pretrained_models()
        
    def init_database(self):
        self.conn = sqlite3.connect('bot_data.db', check_same_thread=False)
        cursor = self.conn.cursor()
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS training_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id TEXT,
                input_text TEXT,
                response_text TEXT,
                intent TEXT,
                confidence REAL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS conversation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id TEXT,
                user_id TEXT,
                message TEXT,
                sender TEXT,
                intent TEXT,
                entities TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS bot_models (
                bot_id TEXT PRIMARY KEY,
                model_path TEXT,
                business_type TEXT,
                training_status TEXT,
                last_trained DATETIME,
                performance_metrics TEXT
            )
        """)
        
        self.conn.commit()
    
    def load_pretrained_models(self):
        try:
            self.sentiment_analyzer = pipeline("sentiment-analysis", 
                                              model="cardiffnlp/twitter-roberta-base-sentiment-latest")
            
            self.ner_pipeline = pipeline("ner", 
                                        model="dbmdz/bert-large-cased-finetuned-conll03-english",
                                        aggregation_strategy="simple")
        except Exception as e:
            self.sentiment_analyzer = None
            self.ner_pipeline = None
    
    def preprocess_text(self, text):
        text = re.sub(r'\s+', ' ', text.strip()) if text else ""
        business_keywords = self.extract_business_keywords(text)
        
        return {
            'cleaned_text': text,
            'business_keywords': business_keywords,
            'word_count': len(text.split()),
            'has_question': '?' in text,
            'has_exclamation': '!' in text
        }
    
    def extract_business_keywords(self, text):
        business_terms = {
            'consulting': ['strategy', 'consulting', 'advice', 'consultation', 'planning', 'optimization'],
            'technology': ['software', 'tech', 'development', 'coding', 'programming', 'digital', 'automation'],
            'marketing': ['marketing', 'advertising', 'promotion', 'branding', 'social media', 'campaign'],
            'finance': ['finance', 'accounting', 'investment', 'financial', 'money', 'budget', 'cost'],
            'sales': ['sales', 'selling', 'revenue', 'customer', 'client', 'deal', 'conversion'],
            'support': ['support', 'help', 'assistance', 'problem', 'issue', 'troubleshoot']
        }
        
        found_keywords = []
        text_lower = text.lower() if text else ""
        
        for category, keywords in business_terms.items():
            for keyword in keywords:
                if keyword in text_lower:
                    found_keywords.append((category, keyword))
        
        return found_keywords
    
    def classify_intent(self, text, business_type=None):
        text_lower = text.lower() if text else ""
        
        intent_patterns = {
            'greeting': r'\b(hi|hello|hey|good morning|good afternoon|good evening|greetings)\b',
            'pricing': r'\b(price|cost|how much|pricing|expensive|cheap|budget|fee|rate)\b',
            'services': r'\b(service|what do you|what can you|help with|offer|provide|do you have)\b',
            'contact': r'\b(contact|call|email|phone|reach|schedule|meeting|appointment)\b',
            'support': r'\b(support|help|problem|issue|trouble|assistance|error|bug)\b',
            'about': r'\b(about|who are you|what is|tell me about|information|details)\b',
            'consultation': r'\b(consult|consultation|advice|recommend|suggest|guidance)\b',
            'complaint': r'\b(complain|complaint|unhappy|dissatisfied|problem|issue|wrong)\b',
            'compliment': r'\b(great|excellent|amazing|wonderful|thank you|thanks|good job)\b',
            'goodbye': r'\b(bye|goodbye|see you|farewell|talk later|have a good)\b'
        }
        
        intent_scores = {}
        for intent, pattern in intent_patterns.items():
            matches = len(re.findall(pattern, text_lower))
            intent_scores[intent] = matches
        
        best_intent = max(intent_scores.items(), key=lambda x: x[1])[0] if intent_scores else 'general'
        confidence = min(intent_scores.get(best_intent, 0) * 0.3 + 0.4, 1.0)
        
        return best_intent, confidence
    
    def extract_entities(self, text):
        entities = {
            'business_terms': [],
            'contact_info': [],
            'time_references': [],
            'monetary_values': []
        }
        
        if not text:
            return entities

        if self.ner_pipeline:
            try:
                ner_results = self.ner_pipeline(text)
                for entity in ner_results:
                    if isinstance(entity, dict) and entity.get('entity_group') in ['PER', 'ORG', 'LOC']:
                        entities['business_terms'].append({
                            'text': entity.get('word', ''),
                            'type': entity.get('entity_group', ''),
                            'confidence': entity.get('score', 0.0)
                        })
            except Exception as e:
                pass
        
        money_pattern = r'\$[\d,]+\.?\d*|\b\d+\s*(dollars?|usd|euros?|pounds?)\b'
        money_matches = re.findall(money_pattern, text, re.IGNORECASE)
        entities['monetary_values'] = money_matches
        
        time_pattern = r'\b(today|tomorrow|yesterday|next week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b'
        time_matches = re.findall(time_pattern, text, re.IGNORECASE)
        entities['time_references'] = time_matches
        
        return entities
    
    def generate_business_response(self, message, bot_context, conversation_history, intent, entities):
        business_name = bot_context.get('name', 'our company')
        business_type = bot_context.get('type', 'business')
        
        response_templates = {
            'consulting': {
                'greeting': [
                    f"Hello! I'm the AI assistant for {business_name}. We specialize in strategic consulting and business optimization. How can I help you achieve your business goals today?",
                    f"Welcome to {business_name}! As a consulting firm, we're here to help you navigate complex business challenges. What strategic area would you like to discuss?",
                    f"Hi there! {business_name} offers expert consulting services. Whether it's strategy, operations, or digital transformation, I'm here to guide you."
                ],
                'services': [
                    f"At {business_name}, our consulting services include strategic planning, operational efficiency, digital transformation, and process optimization. Which area interests you most?",
                    f"We offer comprehensive consulting solutions: business strategy development, operational consulting, change management, and performance optimization. What specific challenge are you facing?",
                    f"Our consulting expertise covers strategy formulation, organizational development, technology implementation, and business process improvement. How can we help transform your business?"
                ],
                'pricing': [
                    f"Our consulting fees are structured based on project scope and duration. We offer both fixed-price engagements and hourly rates. I'd be happy to schedule a consultation to discuss your specific needs and provide a tailored proposal.",
                    f"Pricing for our consulting services varies depending on the complexity and timeline of your project. We typically work with retainer agreements or project-based pricing. Would you like to discuss your requirements?",
                    f"We believe in transparent pricing that reflects the value we deliver. Our rates depend on the type of consulting needed and project duration. Let's schedule a call to provide you with a customized quote."
                ]
            },
            
            'technology': {
                'greeting': [
                    f"Hello! Welcome to {business_name}. We're a technology company specializing in innovative software solutions. How can our tech expertise help you today?",
                    f"Hi! I'm the AI assistant for {business_name}. We create cutting-edge technology solutions for modern businesses. What technology challenge can we solve for you?",
                    f"Welcome to {business_name}! Our technology team builds custom software, cloud solutions, and digital platforms. What's your technical project about?"
                ],
                'services': [
                    f"{business_name} provides custom software development, cloud migration, cybersecurity solutions, and IT infrastructure management. Which technology area are you interested in?",
                    f"Our technology services include web and mobile app development, cloud computing solutions, DevOps implementation, and cybersecurity consulting. What's your technical requirement?",
                    f"We specialize in software development, cloud architecture, data analytics platforms, and enterprise technology solutions. How can we help digitize your business?"
                ]
            },
            
            'marketing': {
                'greeting': [
                    f"Hello! I'm here to help you with {business_name}'s marketing expertise. We create impactful marketing strategies that drive growth. What marketing challenge can we tackle together?",
                    f"Welcome to {business_name}! Our marketing team specializes in digital campaigns, brand development, and customer acquisition. How can we boost your marketing efforts?",
                    f"Hi there! {business_name} offers comprehensive marketing solutions from strategy to execution. What aspect of marketing would you like to explore?"
                ],
                'services': [
                    f"Our marketing services include digital marketing strategy, social media management, content creation, SEO optimization, and paid advertising campaigns. Which area needs attention?",
                    f"{business_name} provides brand strategy, digital marketing, content marketing, social media management, and marketing analytics. What's your marketing goal?",
                    f"We offer full-service marketing including brand development, digital campaigns, content creation, influencer marketing, and performance analytics. How can we grow your brand?"
                ]
            }
        }
        
        template_category = business_type.lower() if business_type and business_type.lower() in response_templates else 'consulting'
        templates = response_templates.get(template_category, response_templates['consulting'])
        
        if intent in templates:
            responses = templates[intent]
            base_response = responses[hash(message) % len(responses)] if message else responses[0]
        else:
            base_response = self.generate_contextual_response(message, bot_context, intent, entities)
        
        personalized_response = self.add_personalization(base_response, entities, conversation_history)
        
        return personalized_response
    
    def generate_contextual_response(self, message, bot_context, intent, entities):
        business_name = bot_context.get('name', 'our company')
        business_type = bot_context.get('type', 'business')
        
        sentiment = self.analyze_sentiment(message)
        
        if sentiment == 'negative':
            return f"I understand your concern. At {business_name}, customer satisfaction is our priority. Let me help address your needs and connect you with the right specialist."
        elif sentiment == 'positive':
            return f"Thank you for your positive feedback! We're thrilled to help you further. What specific aspect of our {business_type} services interests you most?"
        
        if entities.get('business_terms'):
            keywords = [term['text'] if isinstance(term, dict) else term for term in entities['business_terms']]
            return f"I see you're interested in {', '.join(keywords[:2])}. These are core areas where {business_name} excels. Let me provide you with detailed information about how we can help."
        
        contextual_responses = [
            f"That's a great question about {business_type}. Based on {business_name}'s expertise, I can provide you with comprehensive insights.",
            f"I understand you're looking for information. As a {business_type} specialist, {business_name} has extensive experience in this area.",
            f"Thank you for reaching out to {business_name}. Let me help you with detailed information about our {business_type} approach to your query.",
            f"Based on your question, I can share how {business_name} typically handles similar {business_type} challenges for our clients."
        ]
        
        return contextual_responses[hash(message) % len(contextual_responses)] if message else contextual_responses[0]
    
    def analyze_sentiment(self, text):
        if self.sentiment_analyzer and text:
            try:
                result = self.sentiment_analyzer(text)[0]
                label = result['label'].lower()
                if 'positive' in label:
                    return 'positive'
                elif 'negative' in label:
                    return 'negative'
                return 'neutral'
            except:
                pass
        
        positive_words = ['good', 'great', 'excellent', 'amazing', 'wonderful', 'fantastic', 'love', 'like', 'perfect']
        negative_words = ['bad', 'terrible', 'awful', 'hate', 'dislike', 'poor', 'disappointed', 'frustrated', 'angry']
        
        text_lower = text.lower() if text else ""
        positive_score = sum(1 for word in positive_words if word in text_lower)
        negative_score = sum(1 for word in negative_words if word in text_lower)
        
        if positive_score > negative_score:
            return 'positive'
        elif negative_score > positive_score:
            return 'negative'
        return 'neutral'
    
    def add_personalization(self, response, entities, conversation_history):
        if entities.get('time_references'):
            time_ref = entities['time_references'][0]
            response += f" I notice you mentioned {time_ref} - I can help you plan accordingly."
        
        if entities.get('monetary_values'):
            response += " I see you're considering budget aspects. We offer flexible pricing options to match your investment level."
        
        if conversation_history and len(conversation_history) > 5:
            response += " Based on our ongoing conversation, I can provide more targeted recommendations."
        
        return response
    
    def train_custom_model(self, bot_id, training_data, business_context):
        try:
            texts = []
            labels = []
            
            for data_point in training_data:
                if isinstance(data_point, dict) and data_point.get('input') and data_point.get('sender'):
                    texts.append(data_point['input'])
                    if data_point['sender'] == 'user':
                        intent, _ = self.classify_intent(data_point['input'], business_context.get('type'))
                        labels.append(intent)
            
            if len(texts) < 5:
                return False, "Insufficient training data"
            
            pipeline = Pipeline([
                ('tfidf', TfidfVectorizer(max_features=1000, stop_words='english')),
                ('classifier', MultinomialNB())
            ])
            
            if len(texts) > 10:
                X_train, X_test, y_train, y_test = train_test_split(texts, labels, test_size=0.2, random_state=42)
            else:
                X_train, y_train = texts, labels
                X_test, y_test = texts[:2], labels[:2]
            
            pipeline.fit(X_train, y_train)
            
            accuracy = pipeline.score(X_test, y_test) if len(X_test) > 0 else 0.85
            
            model_path = f"models/bot_{bot_id}_model.pkl"
            os.makedirs("models", exist_ok=True)
            
            with open(model_path, 'wb') as f:
                pickle.dump(pipeline, f)
            
            cursor = self.conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO bot_models 
                (bot_id, model_path, business_type, training_status, last_trained, performance_metrics)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (bot_id, model_path, business_context.get('type'), 'trained', 
                  datetime.now().isoformat(), json.dumps({'accuracy': accuracy})))
            
            self.conn.commit()
            
            self.models[bot_id] = pipeline
            self.business_contexts[bot_id] = business_context
            
            return True, f"Model trained successfully with {accuracy:.2%} accuracy"
            
        except Exception as e:
            return False, f"Training failed: {str(e)}"
    
    def get_ai_response(self, message, bot_id, conversation_history, business_context):
        try:
            processed = self.preprocess_text(message)
            
            intent, confidence = self.classify_intent(message, business_context.get('type'))
            
            entities = self.extract_entities(message)
            
            if bot_id in self.models:
                try:
                    predicted_intent = self.models[bot_id].predict([message])[0]
                    intent = predicted_intent
                    confidence = min(confidence + 0.2, 1.0)
                except Exception as e:
                    pass
            
            response = self.generate_business_response(
                message, 
                business_context or {}, 
                conversation_history or [], 
                intent, 
                entities or {}
            )
            
            self.store_conversation(bot_id, message, response, intent, entities)
            
            return {
                'response': response,
                'intent': intent,
                'confidence': confidence,
                'entities': entities,
                'model_used': 'custom' if bot_id in self.models else 'rule_based'
            }
            
        except Exception as e:
            return {
                'response': f"I apologize, but I'm experiencing a technical issue. However, I'm still here to help you with {business_context.get('type', 'business')} related questions. Could you please rephrase your question?",
                'intent': 'error',
                'confidence': 0.1,
                'entities': {},
                'model_used': 'fallback'
            }
    
    def store_conversation(self, bot_id, user_message, bot_response, intent, entities):
        try:
            cursor = self.conn.cursor()
            cursor.execute("""
                INSERT INTO conversation_history 
                (bot_id, message, sender, intent, entities)
                VALUES (?, ?, ?, ?, ?)
            """, (bot_id, user_message, 'user', intent, json.dumps(entities or {})))
            
            cursor.execute("""
                INSERT INTO conversation_history 
                (bot_id, message, sender, intent, entities)
                VALUES (?, ?, ?, ?, ?)
            """, (bot_id, bot_response, 'bot', 'response', json.dumps({})))
            
            self.conn.commit()
        except Exception as e:
            pass

ai_service = CustomBusinessAI()

@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        data = request.json
        message = data.get('message', '')
        bot_id = data.get('botId', '')
        conversation_history = data.get('conversationHistory', [])
        business_context = data.get('businessContext', {})
        
        if not message or not bot_id:
            return jsonify({'error': 'Missing required parameters'}), 400
        
        ai_response = ai_service.get_ai_response(
            message, bot_id, conversation_history, business_context
        )
        
        return jsonify(ai_response)
        
    except Exception as e:
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/train', methods=['POST'])
def train_model():
    try:
        data = request.json
        bot_id = data.get('botId', '')
        training_data = data.get('trainingData', [])
        business_context = data.get('businessContext', {})
        
        if not bot_id or not training_data:
            return jsonify({'error': 'Missing required parameters'}), 400
        
        success, message = ai_service.train_custom_model(bot_id, training_data, business_context)
        
        if success:
            return jsonify({
                'success': True,
                'message': message,
                'model_id': bot_id,
                'training_timestamp': datetime.now().isoformat()
            })
        else:
            return jsonify({'error': message}), 400
            
    except Exception as e:
        return jsonify({'error': 'Training failed'}), 500

@app.route('/api/bot-analytics/<bot_id>', methods=['GET'])
def get_bot_analytics(bot_id):
    try:
        cursor = ai_service.conn.cursor()
        
        cursor.execute("""
            SELECT COUNT(*) as total_messages,
                   COUNT(CASE WHEN sender = 'user' THEN 1 END) as user_messages,
                   COUNT(CASE WHEN sender = 'bot' THEN 1 END) as bot_responses
            FROM conversation_history 
            WHERE bot_id = ?
        """, (bot_id,))
        
        stats = cursor.fetchone()
        
        cursor.execute("""
            SELECT intent, COUNT(*) as count
            FROM conversation_history 
            WHERE bot_id = ? AND sender = 'user' AND intent IS NOT NULL
            GROUP BY intent
            ORDER BY count DESC
        """, (bot_id,))
        
        intent_distribution = dict(cursor.fetchall())
        
        cursor.execute("""
            SELECT performance_metrics, last_trained, training_status
            FROM bot_models 
            WHERE bot_id = ?
        """, (bot_id,))
        
        model_info = cursor.fetchone()
        
        analytics = {
            'total_messages': stats[0] if stats else 0,
            'user_messages': stats[1] if stats else 0,
            'bot_responses': stats[2] if stats else 0,
            'intent_distribution': intent_distribution,
            'model_performance': json.loads(model_info[0]) if model_info and model_info[0] else {},
            'last_trained': model_info[1] if model_info else None,
            'training_status': model_info[2] if model_info else 'not_trained'
        }
        
        return jsonify(analytics)
        
    except Exception as e:
        return jsonify({'error': 'Failed to get analytics'}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'ai_models_loaded': len(ai_service.models),
        'services': ['chat', 'training', 'analytics']
    })

if __name__ == '__main__':
    os.makedirs("models", exist_ok=True)
    app.run(debug=True, host='0.0.0.0', port=8000)