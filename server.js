require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { pool } = require('./config/db');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: false,
}));

// Disable COOP for the Google callback so popup can communicate with opener
app.use('/auth/google/callback', (req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  next();
});

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      'https://botlyra-ai.web.app',
      'https://botlyra-ai.firebaseapp.com',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts, please try again after 15 minutes.'
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/google', authLimiter);
app.use('/api/', apiLimiter);

if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected at:', res.rows[0].now);
  }
});

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const subscriptionRoutes = require('./routes/subscriptions');
const botRoutes = require('./routes/bots');
const busibotsRoutes = require('./routes/busibots');
const customBotsRoutes = require('./routes/custombots');
const adminRoutes = require('./routes/admin');
const botIntegrationsRoutes = require('./routes/botIntegrations');
const botChatsRouter = require('./routes/bot-chats');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/busibots', busibotsRoutes);
app.use('/api/custombots', customBotsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', botIntegrationsRoutes);
app.use('/api/bot-chats', botChatsRouter);

app.get('/api/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'postgresql',
      dbStatus: dbCheck.rows.length > 0 ? 'connected' : 'disconnected',
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'postgresql',
      dbStatus: 'disconnected',
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Botlyra API Server', version: '1.0.0' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';
  res.status(statusCode).json({
    error: {
      message: process.env.NODE_ENV === 'production'
        ? (statusCode === 500 ? 'Internal Server Error' : message)
        : message,
      status: statusCode
    }
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: {
      message: 'Route not found',
      status: 404,
      path: req.path,
      method: req.method
    }
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

process.on('SIGTERM', () => { server.close(() => { pool.end(() => { process.exit(0); }); }); });
process.on('SIGINT', () => { server.close(() => { pool.end(() => { process.exit(0); }); }); });

module.exports = app;