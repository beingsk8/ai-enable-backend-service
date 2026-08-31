import { Router } from 'express';
import { z } from 'zod';
import { 
  createReview, 
  getReviews, 
  getReviewById, 
  deleteReview,
  reviewGitLabMR,
  compareMRs
} from '../controllers/review.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

const createReviewSchema = z.object({
  title: z.string().optional(),
  code: z.string().min(1, 'Code is required'),
  language: z.string().optional(),
  reviewType: z.enum(['snippet', 'diff']).optional().default('snippet')
});

// All routes require authentication
router.use(authenticate);

router.post('/', validate(createReviewSchema), createReview);
router.post('/gitlab-mr', reviewGitLabMR);
router.post('/compare-mrs', compareMRs);
router.get('/', getReviews);
router.get('/:id', getReviewById);
router.delete('/:id', deleteReview);

export default router;
