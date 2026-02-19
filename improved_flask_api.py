import os
import re
import json
import sys
import time
import torch
import argparse
import hashlib
import logging
from datetime import datetime
from functools import wraps
from threading import Lock
from collections import defaultdict, deque
from flask import Flask, request, jsonify
from flask_cors import CORS
from transformers import AutoTokenizer, AutoModelForCausalLM

class ConversationDataConverter:
    def __init__(self):
        self.min_utterance_length = 3
        self.max_utterance_length = 500
        self.conversation_stats = {
            'total_conversations': 0,
            'valid_pairs': 0,
            'filtered_pairs': 0,
            'empty_utterances': 0,
            'too_short': 0,
            'too_long': 0
        }

    def clean_text(self, text):
        if not text:
            return ""
        text = re.sub(r'\s+', ' ', text)
        text = text.replace('__eou__', '').replace('  ', ' ')
        text = re.sub(r'[^\w\s\.\!\?\,\;\:\'\"\-\(\)]', '', text)
        text = text.strip()
        if text and not text[0].isupper() and text[-1] in '.!?':
            text = text[0].upper() + text[1:]
        return text

    def is_valid_utterance(self, utterance):
        if not utterance:
            return False, "empty"
        if len(utterance) < self.min_utterance_length:
            return False, "too_short"
        if len(utterance) > self.max_utterance_length:
            return False, "too_long"
        if re.search(r'(.)\1{5,}', utterance):
            return False, "repetitive"
        special_chars = len(re.findall(r'[^\w\s]', utterance))
        if special_chars > len(utterance) * 0.3:
            return False, "too_many_special_chars"
        return True, "valid"

    def extract_conversations_from_eou_format(self, content):
        conversations = []
        conversation_blocks = content.split('\n\n') if '\n\n' in content else content.split('\n')
        
        for block in conversation_blocks:
            block = block.strip()
            if not block:
                continue
            
            utterances = []
            if '__eou__' in block:
                raw_utterances = block.split('__eou__')
            else:
                raw_utterances = block.split('\n')
            
            for utterance in raw_utterances:
                cleaned = self.clean_text(utterance)
                if cleaned:
                    utterances.append(cleaned)
            
            if len(utterances) >= 2:
                conversations.append(utterances)
                self.conversation_stats['total_conversations'] += 1
        
        return conversations

    def create_training_pairs(self, conversations):
        training_pairs = []
        for conversation in conversations:
            for i in range(len(conversation) - 1):
                input_text = conversation[i]
                target_text = conversation[i + 1]
                
                input_valid, input_reason = self.is_valid_utterance(input_text)
                target_valid, target_reason = self.is_valid_utterance(target_text)
                
                if input_valid and target_valid:
                    training_pairs.append({'input': input_text, 'target': target_text})
                    self.conversation_stats['valid_pairs'] += 1
                else:
                    self.conversation_stats['filtered_pairs'] += 1
                    if not input_valid:
                        self.conversation_stats[input_reason] = self.conversation_stats.get(input_reason, 0) + 1
                    if not target_valid:
                        self.conversation_stats[target_reason] = self.conversation_stats.get(target_reason, 0) + 1
        
        return training_pairs

    def create_metadata(self, source_file, total_pairs):
        return {
            'training_date': datetime.now().strftime('%Y-%m-%d'),
            'version': '2.0',
            'data_sources': f'converted_from_{os.path.basename(source_file)}',
            'topics': 'general_conversation,casual_chat,daily_interactions',
            'last_updated': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'total_training_pairs': total_pairs,
            'conversion_stats': self.conversation_stats,
            'format': 'input_target_pairs',
            'min_utterance_length': self.min_utterance_length,
            'max_utterance_length': self.max_utterance_length
        }

    def save_formatted_data(self, training_pairs, metadata, output_file):
        with open(output_file, 'w', encoding='utf-8') as f:
            for key, value in metadata.items():
                if isinstance(value, dict):
                    f.write(f"[metadata] {key}: {json.dumps(value)}\n")
                else:
                    f.write(f"[metadata] {key}: {value}\n")
            f.write('\n')
            
            for pair in training_pairs:
                f.write("[conversation]\n")
                f.write(f"input: {pair['input']}\n")
                f.write(f"target: {pair['target']}\n")
                f.write('\n')

    def convert_training_data(self, input_file='training_data.txt', output_file='training_data_formatted.txt', show_sample=True):
        try:
            if not os.path.exists(input_file):
                print(f"❌ Error: Input file '{input_file}' not found")
                return False
            
            with open(input_file, 'r', encoding='utf-8') as f:
                content = f.read().strip()
            
            if not content:
                print("❌ Error: Input file is empty")
                return False
            
            conversations = self.extract_conversations_from_eou_format(content)
            training_pairs = self.create_training_pairs(conversations)
            
            if not training_pairs:
                print("❌ Error: No valid training pairs created")
                return False
            
            metadata = self.create_metadata(input_file, len(training_pairs))
            self.save_formatted_data(training_pairs, metadata, output_file)
            
            self.print_conversion_stats(output_file)
            
            if show_sample:
                self.show_sample_data(output_file)
            
            return True
            
        except Exception as e:
            print(f"❌ Error during conversion: {str(e)}")
            return False

    def print_conversion_stats(self, output_file):
        print("\n📈 Conversion Statistics:")
        print("=" * 50)
        print(f"Total conversations processed: {self.conversation_stats['total_conversations']}")
        print(f"Valid training pairs created: {self.conversation_stats['valid_pairs']}")
        print(f"Filtered out pairs: {self.conversation_stats['filtered_pairs']}")
        
        if self.conversation_stats.get('too_short', 0) > 0:
            print(f"Too short utterances: {self.conversation_stats['too_short']}")
        if self.conversation_stats.get('too_long', 0) > 0:
            print(f"Too long utterances: {self.conversation_stats['too_long']}")
        if self.conversation_stats.get('empty', 0) > 0:
            print(f"Empty utterances: {self.conversation_stats['empty']}")
        
        success_rate = (self.conversation_stats['valid_pairs'] / 
                       (self.conversation_stats['valid_pairs'] + self.conversation_stats['filtered_pairs']) * 100
                       if (self.conversation_stats['valid_pairs'] + self.conversation_stats['filtered_pairs']) > 0 else 0)
        
        print(f"Success rate: {success_rate:.1f}%")
        print(f"Output saved to: {output_file}")

    def show_sample_data(self, output_file, num_samples=10):
        print(f"\n📋 Sample of converted data (first {num_samples} pairs):")
        print("=" * 70)
        
        try:
            with open(output_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            conversation_blocks = re.findall(r'\[conversation\]\ninput: (.*?)\ntarget: (.*?)\n', content, re.DOTALL)
            
            for i, (input_text, target_text) in enumerate(conversation_blocks[:num_samples]):
                print(f"Pair {i+1}:")
                print(f"  Input:  {input_text.strip()}")
                print(f"  Target: {target_text.strip()}")
                print()
                
        except Exception as e:
            print(f"Error showing sample: {str(e)}")

app = Flask(__name__)
CORS(app)

MAX_REQUESTS_PER_MINUTE = 60
RATE_LIMIT_WINDOW = 60
CACHE_DURATION = 300
MAX_HISTORY_LENGTH = 10
MAX_CONTEXT_LENGTH = 512
MAX_RESPONSE_LENGTH = 150
MIN_RESPONSE_LENGTH = 10

conversation_memory = defaultdict(dict)
response_cache = {}
rate_limiter = defaultdict(deque)
cache_lock = Lock()
memory_lock = Lock()
rate_lock = Lock()

model = None
tokenizer = None
model_info = {}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def load_model():
    global model, tokenizer, model_info
    
    try:
        if os.path.exists('./fine_tuned_chatbot'):
            tokenizer = AutoTokenizer.from_pretrained('./fine_tuned_chatbot')
            model = AutoModelForCausalLM.from_pretrained('./fine_tuned_chatbot')
            try:
                with open('./fine_tuned_chatbot/training_info.json', 'r') as f:
                    model_info = json.load(f)
            except:
                model_info = {'model_type': 'fine_tuned', 'base_model': 'DialoGPT'}
        else:
            model_name = 'microsoft/DialoGPT-large'
            tokenizer = AutoTokenizer.from_pretrained(model_name)
            model = AutoModelForCausalLM.from_pretrained(model_name)
            model_info = {'model_type': 'base', 'base_model': model_name}
        
        # Fix tokenizer configuration for decoder-only models
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        
        # Set padding side to left for decoder-only models (GPT-style)
        tokenizer.padding_side = 'left'
        
        model.eval()
        logger.info("Model loaded successfully with optimized tokenizer settings")
        
    except Exception as e:
        logger.error(f"Error loading model: {e}")
        raise

def rate_limited(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        data = request.get_json(silent=True) or {}
        user_id = data.get('user_id', 'anonymous')

        with rate_lock:
            if user_id not in rate_limiter:
                rate_limiter[user_id] = deque()

            current_time = time.time()
            user_requests = rate_limiter[user_id]

            while user_requests and current_time - user_requests[0] > RATE_LIMIT_WINDOW:
                user_requests.popleft()

            if len(user_requests) >= MAX_REQUESTS_PER_MINUTE:
                return jsonify({"status": "error", "message": "Rate limit exceeded."}), 429

            user_requests.append(current_time)

        return f(*args, **kwargs)
    return decorated_function

def get_conversation_key(user_id, bot_id):
    return f"{user_id}:{bot_id}"

def score_response_quality(response, input_text):
    if not response:
        return 0.0
    
    score = 0.5
    words = response.split()
    
    ideal_length = 15
    length_score = min(1.0, len(words) / ideal_length)
    score += 0.2 * length_score
    
    if any(w in input_text.lower() for w in ['who', 'what', 'when', 'where', 'why', 'how']):
        if any(w in response.lower() for w in ['because', 'reason', 'answer', 'explanation']):
            score += 0.2
    
    unique_words = len(set(words))
    if len(words) > 0:
        uniqueness = unique_words / len(words)
        score += 0.1 * uniqueness
    
    return min(1.0, score)

def post_process_response(response):
    if response and response[0].islower():
        response = response[0].upper() + response[1:]
    
    response = ' '.join(response.split())
    
    if response and response[-1] not in {'.', '!', '?'}:
        response += '.'
    
    return response

def clean_and_validate_response(response_text, input_text):
    if not response_text:
        return None
    
    if tokenizer is not None:
        if hasattr(tokenizer, 'eos_token') and tokenizer.eos_token:
            response_text = response_text.replace(tokenizer.eos_token, '')
        if hasattr(tokenizer, 'pad_token') and tokenizer.pad_token:
            response_text = response_text.replace(tokenizer.pad_token, '')
    
    sentences = [s.strip() for s in response_text.split('.') if s.strip()]
    unique_sentences = []
    seen = set()
    for sent in sentences:
        if sent.lower() not in seen:
            seen.add(sent.lower())
            unique_sentences.append(sent)
    response_text = '. '.join(unique_sentences).strip()
    
    if response_text and response_text[-1] not in {'.', '!', '?'}:
        response_text += '.'
    
    if len(response_text) < MIN_RESPONSE_LENGTH:
        return None
    if len(response_text) > MAX_RESPONSE_LENGTH:
        response_text = response_text[:MAX_RESPONSE_LENGTH].rsplit(' ', 1)[0]
        if not response_text.endswith(('.', '!', '?')):
            response_text += '.'
    
    return response_text

def get_fallback_response(input_text):
    input_lower = input_text.lower()
    
    if any(word in input_lower for word in ['weather', 'forecast', 'rain']):
        return "For accurate weather information, I recommend checking a dedicated weather service."
    
    if any(word in input_lower for word in ['time', 'date', 'hour']):
        return "I don't have real-time clock access. Please check your device for the current time."
    
    if input_lower.startswith(('who is', 'what is', 'where is', 'when did')):
        return "I don't have that information readily available. Would you like me to suggest where to find it?"
    
    fallbacks = [
        "Could you please rephrase your question? I want to make sure I understand correctly.",
        "That's an interesting topic. Could you elaborate on what specifically you'd like to know?",
        "I'm still learning about this subject. Could we discuss something related?",
        "Let me think about that. In the meantime, could you clarify your question?",
        "I want to provide you with the best answer. Could you give me more details?"
    ]
    
    return fallbacks[hash(input_text) % len(fallbacks)]

def build_conversation_context(history):
    if not history:
        return ""
    
    context = ""
    recent_history = list(history)[-MAX_HISTORY_LENGTH*2:]
    
    eos_token = ""
    if tokenizer is not None and hasattr(tokenizer, 'eos_token') and tokenizer.eos_token:
        eos_token = tokenizer.eos_token
    
    for msg in recent_history:
        sender = msg.get('sender', '').lower()
        message = msg.get('message', '').strip()
        
        if sender == 'user':
            context += message + eos_token
        elif sender == 'bot':
            context += message + eos_token
    
    return context

def generate_response(input_text, context, history, user_id, bot_id):
    if tokenizer is None or model is None:
        return "The chatbot service is currently unavailable. Please try again later."
    
    input_text = input_text.strip()
    if not input_text:
        return "I didn't receive your message. Could you please repeat it?"
    
    conv_key = get_conversation_key(user_id, bot_id)
    cache_key = hashlib.md5(f"{input_text}:{conv_key}".encode()).hexdigest()
    
    with cache_lock:
        cached = response_cache.get(cache_key)
        if cached and time.time() - cached['timestamp'] < CACHE_DURATION:
            return cached['response']
    
    try:
        if not history:
            with memory_lock:
                conv_data = conversation_memory.get(conv_key, {})
                history = list(conv_data.get('history', []))
        
        conversation_context = build_conversation_context(history)
        
        eos_token = ""
        if tokenizer is not None and hasattr(tokenizer, 'eos_token') and tokenizer.eos_token:
            eos_token = tokenizer.eos_token
            
        if conversation_context:
            full_prompt = conversation_context + input_text + eos_token
        else:
            full_prompt = input_text + eos_token
        
        inputs = tokenizer.encode(
            full_prompt, 
            return_tensors='pt', 
            max_length=MAX_CONTEXT_LENGTH, 
            truncation=True,
            add_special_tokens=False
        )
        
        with torch.no_grad():
            # Fixed generation parameters to remove warnings
            outputs = model.generate(
                inputs,
                max_new_tokens=100,
                num_return_sequences=1,
                temperature=0.7,
                do_sample=True,
                top_k=50,
                top_p=0.85,
                repetition_penalty=1.2,
                no_repeat_ngram_size=4,
                # Removed early_stopping since we're not using beam search
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
                # Add attention mask for better generation
                attention_mask=torch.ones_like(inputs)
            )
        
        full_response = tokenizer.decode(outputs[0], skip_special_tokens=True)
        
        if full_prompt in full_response:
            bot_response = full_response.replace(full_prompt, '').strip()
        else:
            if input_text in full_response:
                parts = full_response.split(input_text, 1)
                bot_response = parts[1].strip() if len(parts) > 1 else full_response.strip()
            else:
                bot_response = full_response.strip()
        
        cleaned_response = clean_and_validate_response(bot_response, input_text)
        
        if not cleaned_response or score_response_quality(cleaned_response, input_text) < 0.3:
            cleaned_response = get_fallback_response(input_text)
        
        final_response = post_process_response(cleaned_response)
        
        with cache_lock:
            response_cache[cache_key] = {
                'response': final_response, 
                'timestamp': time.time()
            }
        
        with memory_lock:
            if conv_key not in conversation_memory:
                conversation_memory[conv_key] = {
                    'history': deque(maxlen=MAX_HISTORY_LENGTH*2), 
                    'context': context
                }
            
            conversation_memory[conv_key]['history'].extend([
                {
                    'sender': 'user', 
                    'message': input_text, 
                    'timestamp': datetime.utcnow().isoformat()
                },
                {
                    'sender': 'bot', 
                    'message': final_response, 
                    'timestamp': datetime.utcnow().isoformat()
                }
            ])
        
        return final_response
        
    except Exception as e:
        logger.error(f"Error generating response: {e}")
        return get_fallback_response(input_text)

@app.route('/model/info', methods=['GET'])
def get_model_info():
    try:
        info = {
            "status": "success",
            "model_info": {
                "type": model_info.get('model_type', 'unknown'),
                "base_model": model_info.get('base_model', 'unknown'),
                "vocabulary_size": len(tokenizer) if tokenizer else 0,
                "max_context_length": MAX_CONTEXT_LENGTH,
                "max_response_length": MAX_RESPONSE_LENGTH,
                "tokenizer_padding_side": tokenizer.padding_side if tokenizer else 'unknown'
            },
            "training_info": {
                "epoch": model_info.get('epoch', 'N/A'),
                "train_loss": model_info.get('train_loss', 'N/A'),
                "val_loss": model_info.get('val_loss', 'N/A'),
                "metadata": model_info.get('metadata', {})
            },
            "server_info": {
                "active_conversations": len(conversation_memory),
                "cached_responses": len(response_cache),
                "model_loaded": model is not None
            }
        }
        return jsonify(info), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/predict', methods=['POST'])
@rate_limited
def predict():
    start_time = time.time()
    
    if model is None or tokenizer is None:
        return jsonify({
            "status": "error",
            "message": "Chatbot service is currently unavailable",
            "timestamp": datetime.utcnow().isoformat()
        }), 503
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "No data provided"}), 400
            
        user_message = data.get('message', '').strip()
        if not user_message:
            return jsonify({"status": "error", "message": "Empty message"}), 400
            
        if len(user_message) > 500:
            return jsonify({"status": "error", "message": "Message exceeds maximum length"}), 400
            
        bot_context = data.get('bot_context', {})
        conversation_history = data.get('conversation_history', [])
        user_id = data.get('user_id', 'anonymous')
        bot_id = data.get('bot_id', 'default')
        
        response_text = generate_response(
            input_text=user_message,
            context=bot_context,
            history=conversation_history,
            user_id=user_id,
            bot_id=bot_id
        )
        
        processing_time = round(time.time() - start_time, 3)
        
        return jsonify({
            "status": "success",
            "response": response_text,
            "processing_time": processing_time,
            "timestamp": datetime.utcnow().isoformat(),
            "model_type": model_info.get('model_type', 'unknown')
        }), 200
        
    except Exception as e:
        logger.error(f"Error in predict endpoint: {e}")
        return jsonify({
            "status": "error",
            "message": "I'm experiencing technical difficulties. Please try again.",
            "timestamp": datetime.utcnow().isoformat()
        }), 500

@app.route('/conversation/history', methods=['GET'])
def get_conversation_history():
    try:
        user_id = request.args.get('user_id')
        bot_id = request.args.get('bot_id')
        
        if not user_id or not bot_id:
            return jsonify({"status": "error", "message": "user_id and bot_id required"}), 400
        
        conv_key = get_conversation_key(user_id, bot_id)
        
        with memory_lock:
            conversation = conversation_memory.get(conv_key, {})
            history = list(conversation.get('history', []))
        
        return jsonify({
            "status": "success",
            "history": history,
            "total_messages": len(history)
        }), 200
        
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/conversation/clear', methods=['POST'])
def clear_conversation():
    try:
        data = request.get_json()
        user_id = data.get('user_id') if data else None
        bot_id = data.get('bot_id') if data else None
        
        if user_id and bot_id:
            conv_key = get_conversation_key(user_id, bot_id)
            with memory_lock:
                if conv_key in conversation_memory:
                    del conversation_memory[conv_key]
            message = f"Conversation history cleared"
        else:
            with memory_lock:
                conversation_memory.clear()
            with cache_lock:
                response_cache.clear()
            message = "All conversation data cleared"
            
        return jsonify({"status": "success", "message": message}), 200
        
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "active_conversations": len(conversation_memory),
        "cached_responses": len(response_cache),
        "model_loaded": model is not None,
        "model_type": model_info.get('model_type', 'unknown')
    }), 200

@app.route('/ready', methods=['GET'])
def readiness_check():
    if model is None or tokenizer is None:
        return jsonify({"status": "not ready", "message": "Model not loaded"}), 503
    return jsonify({"status": "ready"}), 200

@app.errorhandler(404)
def not_found(error):
    return jsonify({"status": "error", "message": "Endpoint not found"}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({"status": "error", "message": "Internal server error"}), 500

def main():
    parser = argparse.ArgumentParser(description='Convert conversation data for chatbot training')
    parser.add_argument('--input', '-i', default='training_data.txt', help='Input file path')
    parser.add_argument('--output', '-o', default='training_data_formatted.txt', help='Output file path')
    parser.add_argument('--no-sample', action='store_true', help='Don\'t show sample data')
    parser.add_argument('--min-length', type=int, default=3, help='Minimum utterance length')
    parser.add_argument('--max-length', type=int, default=500, help='Maximum utterance length')
    
    args = parser.parse_args()
    
    converter = ConversationDataConverter()
    converter.min_utterance_length = args.min_length
    converter.max_utterance_length = args.max_length
    
    success = converter.convert_training_data(
        input_file=args.input,
        output_file=args.output,
        show_sample=not args.no_sample
    )
    
    if success:
        print("✅ Conversion completed successfully!")
    else:
        print("❌ Conversion failed!")
        exit(1)

if __name__ == "__main__":
    logger.info("Loading chatbot model...")
    try:
        load_model()
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        sys.exit(1)
    
    logger.info("Starting Flask server...")
    app.run(host='0.0.0.0', port=5000, threaded=True, debug=False)