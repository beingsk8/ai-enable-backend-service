import { Response } from 'express';
import { prisma } from '../utils/prisma.js';
import { reviewCode, detectLanguage } from '../services/ai.service.js';
import { AuthRequest } from '../middleware/auth.middleware.js';
import { fetchGitLabMRDiff, formatMRDiffForReview, parseGitLabMRUrl, compareTwoMRs } from '../services/gitlab.service.js';

export async function createReview(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { title, code, language, reviewType } = req.body;

    // Auto-detect language if not provided
    const detectedLanguage = language || detectLanguage(code);

    // Get AI review
    const aiReview = await reviewCode(code, detectedLanguage, reviewType);

    // Save review to database
    const review = await prisma.review.create({
      data: {
        userId,
        title: title || `Code Review - ${new Date().toLocaleDateString()}`,
        code,
        language: detectedLanguage,
        reviewType: reviewType || 'snippet',
        summary: aiReview.summary,
        issues: JSON.stringify(aiReview.issues),
        suggestions: JSON.stringify(aiReview.suggestions),
        criticalCount: aiReview.metrics.critical,
        warningCount: aiReview.metrics.warning,
        infoCount: aiReview.metrics.info,
        githubComments: JSON.stringify(aiReview.githubComments)
      }
    });

    // Update analytics
    const issueTypes = aiReview.issues.map(i => i.type);
    const uniqueTypes = [...new Set(issueTypes)];
    
    for (const type of uniqueTypes) {
      const count = issueTypes.filter(t => t === type).length;
      await prisma.analytics.create({
        data: {
          userId,
          issueType: type,
          count
        }
      });
    }

    res.status(201).json({
      message: 'Review created successfully',
      review: {
        id: review.id,
        title: review.title,
        language: review.language,
        reviewType: review.reviewType,
        summary: aiReview.summary,
        issues: aiReview.issues,
        suggestions: aiReview.suggestions,
        metrics: aiReview.metrics,
        githubComments: aiReview.githubComments,
        createdAt: review.createdAt
      }
    });
  } catch (error) {
    console.error('Create review error:', error);
    res.status(500).json({ error: 'Failed to create review' });
  }
}

export async function getReviews(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          language: true,
          reviewType: true,
          summary: true,
          criticalCount: true,
          warningCount: true,
          infoCount: true,
          createdAt: true
        }
      }),
      prisma.review.count({ where: { userId } })
    ]);

    res.json({
      reviews,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
}

export async function getReviewById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    const id = req.params.id as string;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const review = await prisma.review.findFirst({
      where: { id: id, userId: userId }
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    res.json({
      review: {
        id: review.id,
        title: review.title,
        code: review.code,
        language: review.language,
        reviewType: review.reviewType,
        summary: review.summary,
        issues: JSON.parse(review.issues),
        suggestions: JSON.parse(review.suggestions),
        metrics: {
          critical: review.criticalCount,
          warning: review.warningCount,
          info: review.infoCount
        },
        githubComments: review.githubComments ? JSON.parse(review.githubComments) : [],
        createdAt: review.createdAt
      }
    });
  } catch (error) {
    console.error('Get review by id error:', error);
    res.status(500).json({ error: 'Failed to get review' });
  }
}

export async function deleteReview(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    const id = req.params.id as string;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const review = await prisma.review.findFirst({
      where: { id: id, userId: userId }
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    await prisma.review.delete({ where: { id: id } });

    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
}

// Review GitLab Merge Request
export async function reviewGitLabMR(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { mrUrl, gitlabToken } = req.body;

    if (!mrUrl) {
      res.status(400).json({ error: 'GitLab MR URL is required' });
      return;
    }

    // Validate URL format
    const parsed = parseGitLabMRUrl(mrUrl);
    if (!parsed) {
      res.status(400).json({ error: 'Invalid GitLab MR URL format. Expected: https://gitlab.com/user/project/-/merge_requests/123' });
      return;
    }

    console.log(`Fetching MR from: ${parsed.baseUrl}/${parsed.projectPath} MR #${parsed.mrIid}`);

    // Fetch MR diff from GitLab
    const mrInfo = await fetchGitLabMRDiff(mrUrl, gitlabToken);
    
    if (!mrInfo.diffs || mrInfo.diffs.length === 0) {
      res.status(400).json({ error: 'No changes found in this merge request' });
      return;
    }

    console.log(`MR has ${mrInfo.diffs.length} changed files`);

    // Format the diff for review
    const formattedDiff = formatMRDiffForReview(mrInfo);
    console.log(`Formatted diff size: ${formattedDiff.length} characters`);

    // Get AI review (will automatically chunk if too large)
    const aiReview = await reviewCode(formattedDiff, 'diff', 'diff');

    // Save review to database
    const review = await prisma.review.create({
      data: {
        userId,
        title: `MR Review: ${mrInfo.title}`,
        code: formattedDiff,
        language: 'diff',
        reviewType: 'diff',
        summary: aiReview.summary,
        issues: JSON.stringify(aiReview.issues),
        suggestions: JSON.stringify(aiReview.suggestions),
        criticalCount: aiReview.metrics.critical,
        warningCount: aiReview.metrics.warning,
        infoCount: aiReview.metrics.info,
        githubComments: JSON.stringify(aiReview.githubComments)
      }
    });

    // Update analytics
    const issueTypes = aiReview.issues.map(i => i.type);
    const uniqueTypes = [...new Set(issueTypes)];
    
    for (const type of uniqueTypes) {
      const count = issueTypes.filter(t => t === type).length;
      await prisma.analytics.create({
        data: {
          userId,
          issueType: type,
          count
        }
      });
    }

    res.status(201).json({
      message: 'MR Review created successfully',
      review: {
        id: review.id,
        title: review.title,
        mrInfo: {
          title: mrInfo.title,
          description: mrInfo.description,
          sourceBranch: mrInfo.source_branch,
          targetBranch: mrInfo.target_branch,
          author: mrInfo.author,
          filesChanged: mrInfo.diffs.length
        },
        language: review.language,
        reviewType: review.reviewType,
        summary: aiReview.summary,
        issues: aiReview.issues,
        suggestions: aiReview.suggestions,
        metrics: aiReview.metrics,
        githubComments: aiReview.githubComments,
        chunksReviewed: aiReview.chunksReviewed,
        createdAt: review.createdAt
      }
    });
  } catch (error: any) {
    console.error('GitLab MR review error:', error);
    
    let errorMessage = 'Failed to review GitLab MR';
    let hint: string | undefined;
    
    if (error.message?.includes('401') || error.message?.includes('403') || error.message?.includes('access denied')) {
      errorMessage = 'GitLab API access denied';
      hint = 'For private repositories, please provide a GitLab access token';
    } else if (error.message?.includes('404')) {
      errorMessage = 'Merge request not found';
      hint = 'Please check the MR URL is correct and you have access to the repository';
    } else if (error.message?.includes('too large') || error.message?.includes('token')) {
      errorMessage = 'The merge request is too large to review';
      hint = 'The system will automatically split large MRs into chunks. Please try again.';
    }
    
    res.status(500).json({ 
      error: errorMessage,
      hint
    });
  }
}

// Compare Two GitLab Merge Requests
export async function compareMRs(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { mr1Url, mr2Url, gitlabToken } = req.body;

    if (!mr1Url || !mr2Url) {
      res.status(400).json({ error: 'Both MR URLs are required' });
      return;
    }

    // Validate URL formats
    const parsed1 = parseGitLabMRUrl(mr1Url);
    const parsed2 = parseGitLabMRUrl(mr2Url);

    if (!parsed1) {
      res.status(400).json({ error: 'Invalid GitLab MR 1 URL format' });
      return;
    }

    if (!parsed2) {
      res.status(400).json({ error: 'Invalid GitLab MR 2 URL format' });
      return;
    }

    console.log(`Comparing MRs: MR1 #${parsed1.mrIid} vs MR2 #${parsed2.mrIid}`);

    // Compare the two MRs
    const comparison = await compareTwoMRs(mr1Url, mr2Url, gitlabToken);

    console.log(`Comparison: ${comparison.comparison.commonFiles.length} common files, ${comparison.comparison.onlyInMR1.length} only in MR1, ${comparison.comparison.onlyInMR2.length} only in MR2`);

    // Get AI review of the comparison (will automatically chunk if too large)
    const aiReview = await reviewCode(comparison.combinedDiffForReview, 'diff', 'diff');

    // Save comparison review to database
    const review = await prisma.review.create({
      data: {
        userId,
        title: `MR Comparison: ${comparison.mr1.title} vs ${comparison.mr2.title}`,
        code: comparison.combinedDiffForReview,
        language: 'diff',
        reviewType: 'diff',
        summary: aiReview.summary,
        issues: JSON.stringify(aiReview.issues),
        suggestions: JSON.stringify(aiReview.suggestions),
        criticalCount: aiReview.metrics.critical,
        warningCount: aiReview.metrics.warning,
        infoCount: aiReview.metrics.info,
        githubComments: JSON.stringify(aiReview.githubComments)
      }
    });

    // Update analytics
    const issueTypes = aiReview.issues.map(i => i.type);
    const uniqueTypes = [...new Set(issueTypes)];
    
    for (const type of uniqueTypes) {
      const count = issueTypes.filter(t => t === type).length;
      await prisma.analytics.create({
        data: {
          userId,
          issueType: type,
          count
        }
      });
    }

    res.status(201).json({
      message: 'MR Comparison completed successfully',
      review: {
        id: review.id,
        title: review.title,
        comparisonInfo: {
          mr1: comparison.mr1,
          mr2: comparison.mr2,
          commonFiles: comparison.comparison.commonFiles,
          onlyInMR1: comparison.comparison.onlyInMR1,
          onlyInMR2: comparison.comparison.onlyInMR2,
          totalFilesCompared: comparison.comparison.fileDiffs.length
        },
        summary: aiReview.summary,
        issues: aiReview.issues,
        suggestions: aiReview.suggestions,
        metrics: aiReview.metrics,
        githubComments: aiReview.githubComments,
        chunksReviewed: aiReview.chunksReviewed,
        createdAt: review.createdAt
      }
    });
  } catch (error: any) {
    console.error('MR Comparison error:', error);
    
    let errorMessage = 'Failed to compare MRs';
    let hint: string | undefined;
    
    if (error.message?.includes('401') || error.message?.includes('403') || error.message?.includes('access denied')) {
      errorMessage = 'GitLab API access denied';
      hint = 'For private repositories, please provide a GitLab access token';
    } else if (error.message?.includes('404')) {
      errorMessage = 'One or both merge requests not found';
      hint = 'Please check both MR URLs are correct and you have access';
    }
    
    res.status(500).json({ 
      error: errorMessage,
      hint
    });
  }
}
