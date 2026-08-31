import { Router } from 'express';
import { getAnalytics, getIssuesTrend } from '../controllers/analytics.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get('/', getAnalytics);
router.get('/trend', getIssuesTrend);

export default router;
