import { Response } from 'express';
import { prisma } from '../utils/prisma.js';
import { AuthRequest } from '../middleware/auth.middleware.js';

export async function getAnalytics(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Get date range from query params (default: last 30 days)
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get total reviews
    const totalReviews = await prisma.review.count({
      where: { userId }
    });

    // Get reviews in date range
    const recentReviews = await prisma.review.findMany({
      where: {
        userId,
        createdAt: { gte: startDate }
      },
      select: {
        criticalCount: true,
        warningCount: true,
        infoCount: true,
        createdAt: true
      }
    });

    // Calculate totals
    const totals = recentReviews.reduce(
      (acc, review) => ({
        critical: acc.critical + review.criticalCount,
        warning: acc.warning + review.warningCount,
        info: acc.info + review.infoCount
      }),
      { critical: 0, warning: 0, info: 0 }
    );

    // Get issue type breakdown
    const issueTypeBreakdown = await prisma.analytics.groupBy({
      by: ['issueType'],
      where: {
        userId,
        date: { gte: startDate }
      },
      _sum: {
        count: true
      }
    });

    // Get daily review counts for chart
    const dailyReviews = await prisma.review.groupBy({
      by: ['createdAt'],
      where: {
        userId,
        createdAt: { gte: startDate }
      },
      _count: true
    });

    // Format daily data
    const reviewsByDay: Record<string, number> = {};
    dailyReviews.forEach(item => {
      const date = new Date(item.createdAt).toISOString().split('T')[0];
      reviewsByDay[date] = (reviewsByDay[date] || 0) + item._count;
    });

    // Get top issues (most common)
    const topIssues = issueTypeBreakdown
      .map(item => ({
        type: item.issueType,
        count: item._sum.count || 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.json({
      analytics: {
        overview: {
          totalReviews,
          reviewsInPeriod: recentReviews.length,
          period: `${days} days`
        },
        severityTotals: totals,
        issueTypeBreakdown: issueTypeBreakdown.map(item => ({
          type: item.issueType,
          count: item._sum.count || 0
        })),
        topIssues,
        reviewsByDay: Object.entries(reviewsByDay).map(([date, count]) => ({
          date,
          count
        })).sort((a, b) => a.date.localeCompare(b.date))
      }
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
}

export async function getIssuesTrend(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get all analytics entries in date range
    const analytics = await prisma.analytics.findMany({
      where: {
        userId,
        date: { gte: startDate }
      },
      orderBy: { date: 'asc' }
    });

    // Group by date and issue type
    const trend: Record<string, Record<string, number>> = {};
    
    analytics.forEach(item => {
      const date = new Date(item.date).toISOString().split('T')[0];
      if (!trend[date]) {
        trend[date] = {};
      }
      trend[date][item.issueType] = (trend[date][item.issueType] || 0) + item.count;
    });

    const trendData = Object.entries(trend).map(([date, issues]) => ({
      date,
      ...issues
    })).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ trend: trendData });
  } catch (error) {
    console.error('Get issues trend error:', error);
    res.status(500).json({ error: 'Failed to get issues trend' });
  }
}
