import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';

import authRoutes from './routes/auth.routes.js';
import reviewRoutes from './routes/review.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import { errorHandler } from './middleware/error.middleware.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// ===================
// SECURITY MIDDLEWARE
// ===================

// Helmet for security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: isProduction ? undefined : false,
}));

// Compression for better performance
app.use(compression());

// CORS configuration
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:5173', 'http://localhost:5174'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parser with size limit
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===================
// RATE LIMITING
// ===================

// General rate limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 100 : 1000, // More lenient in dev
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiter for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 10 : 100, // Very strict for auth
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for AI reviews (expensive operations)
const reviewLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isProduction ? 10 : 50, // 10 reviews per minute in production
  message: { error: 'Review rate limit exceeded. Please wait before submitting another review.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// ===================
// REQUEST LOGGING
// ===================

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!isProduction || req.path !== '/health') {
      console.log(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
    }
  });
  next();
});

// ===================
// HEALTH CHECK
// ===================

app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// API info endpoint
app.get('/api', (req: Request, res: Response) => {
  res.json({
    name: 'AI Code Review Assistant API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      reviews: '/api/reviews',
      analytics: '/api/analytics'
    }
  });
});

// ===================
// ROUTES
// ===================

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/reviews', reviewLimiter, reviewRoutes);
app.use('/api/analytics', analyticsRoutes);

// ===================
// ERROR HANDLING
// ===================

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use(errorHandler);

// ===================
// START SERVER
// ===================

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║     AI Code Review Assistant - Backend Server      ║
╠════════════════════════════════════════════════════╣
║  🚀 Server:     http://localhost:${PORT}               ║
║  📊 Health:     http://localhost:${PORT}/health        ║
║  🌍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(28)}║
║  🔒 CORS:       ${allowedOrigins[0]?.substring(0, 28).padEnd(28)}║
╚════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
