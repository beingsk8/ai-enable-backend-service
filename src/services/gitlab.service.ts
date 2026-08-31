import https from 'https';

export interface GitLabMRDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
}

export interface GitLabMRInfo {
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  author: string;
  diffs: GitLabMRDiff[];
}

/**
 * Parse GitLab MR URL to extract base URL, project path, and MR IID
 * Supports formats:
 * - https://gitlab.com/user/project/-/merge_requests/123
 * - https://gitlab.com/user/project/-/merge_requests/123/diffs
 * - https://repo.example.com/group/project/-/merge_requests/123
 */
export function parseGitLabMRUrl(url: string): { 
  baseUrl: string; 
  projectPath: string; 
  mrIid: string;
} | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    
    // Find merge_requests in path
    const mrIndex = pathParts.findIndex(p => p === 'merge_requests');
    if (mrIndex === -1) return null;
    
    // MR IID is right after merge_requests
    const mrIid = pathParts[mrIndex + 1];
    if (!mrIid || isNaN(parseInt(mrIid))) return null;
    
    // Project path is everything before /-/merge_requests
    const dashIndex = pathParts.findIndex(p => p === '-');
    if (dashIndex === -1) return null;
    
    const projectPath = pathParts.slice(1, dashIndex).join('/');
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
    
    return { baseUrl, projectPath, mrIid };
  } catch {
    return null;
  }
}

/**
 * Fetch MR diff from GitLab API
 * Note: For private repos, you'll need a GitLab access token
 */
export async function fetchGitLabMRDiff(
  mrUrl: string, 
  accessToken?: string
): Promise<GitLabMRInfo> {
  const parsed = parseGitLabMRUrl(mrUrl);
  if (!parsed) {
    throw new Error('Invalid GitLab MR URL format');
  }

  const { baseUrl, projectPath, mrIid } = parsed;
  const encodedProject = encodeURIComponent(projectPath);
  
  // Fetch MR details
  const mrApiUrl = `${baseUrl}/api/v4/projects/${encodedProject}/merge_requests/${mrIid}`;
  const diffApiUrl = `${baseUrl}/api/v4/projects/${encodedProject}/merge_requests/${mrIid}/diffs`;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  
  if (accessToken) {
    headers['PRIVATE-TOKEN'] = accessToken;
  }

  try {
    // Fetch MR info
    const mrInfo = await fetchJson(mrApiUrl, headers);
    
    // Fetch diffs
    const diffs = await fetchJson(diffApiUrl, headers);

    return {
      title: mrInfo.title || 'Untitled MR',
      description: mrInfo.description || '',
      source_branch: mrInfo.source_branch || '',
      target_branch: mrInfo.target_branch || '',
      author: mrInfo.author?.name || mrInfo.author?.username || 'Unknown',
      diffs: diffs.map((d: any) => ({
        old_path: d.old_path,
        new_path: d.new_path,
        diff: d.diff,
        new_file: d.new_file,
        deleted_file: d.deleted_file,
      })),
    };
  } catch (error: any) {
    if (error.message.includes('401') || error.message.includes('403')) {
      throw new Error('GitLab API access denied. Please provide a valid access token for private repositories.');
    }
    throw error;
  }
}

/**
 * Format MR diffs into a readable format for AI review
 */
export function formatMRDiffForReview(mrInfo: GitLabMRInfo): string {
  let formatted = `# Merge Request: ${mrInfo.title}\n`;
  formatted += `**Branch:** ${mrInfo.source_branch} → ${mrInfo.target_branch}\n`;
  formatted += `**Author:** ${mrInfo.author}\n\n`;
  
  if (mrInfo.description) {
    formatted += `## Description\n${mrInfo.description}\n\n`;
  }
  
  formatted += `## Changes\n\n`;
  
  for (const diff of mrInfo.diffs) {
    const status = diff.new_file ? '[NEW]' : diff.deleted_file ? '[DELETED]' : '[MODIFIED]';
    formatted += `### ${status} ${diff.new_path}\n`;
    formatted += '```diff\n';
    formatted += diff.diff || '(binary or empty file)';
    formatted += '\n```\n\n';
  }
  
  return formatted;
}

/**
 * Compare two MRs and generate a comparison report
 */
export interface MRComparisonResult {
  mr1: {
    title: string;
    branch: string;
    author: string;
    filesChanged: number;
    files: string[];
  };
  mr2: {
    title: string;
    branch: string;
    author: string;
    filesChanged: number;
    files: string[];
  };
  comparison: {
    commonFiles: string[];
    onlyInMR1: string[];
    onlyInMR2: string[];
    fileDiffs: FileDiffComparison[];
  };
  combinedDiffForReview: string;
}

export interface FileDiffComparison {
  filePath: string;
  inMR1: boolean;
  inMR2: boolean;
  mr1Diff?: string;
  mr2Diff?: string;
  hasDifferences: boolean;
}

export async function compareTwoMRs(
  mr1Url: string,
  mr2Url: string,
  accessToken?: string
): Promise<MRComparisonResult> {
  // Fetch both MRs
  const [mr1Info, mr2Info] = await Promise.all([
    fetchGitLabMRDiff(mr1Url, accessToken),
    fetchGitLabMRDiff(mr2Url, accessToken)
  ]);

  // Extract file paths from each MR
  const mr1Files = mr1Info.diffs.map(d => d.new_path);
  const mr2Files = mr2Info.diffs.map(d => d.new_path);

  // Find common and unique files
  const commonFiles = mr1Files.filter(f => mr2Files.includes(f));
  const onlyInMR1 = mr1Files.filter(f => !mr2Files.includes(f));
  const onlyInMR2 = mr2Files.filter(f => !mr1Files.includes(f));

  // Build file diff comparisons
  const allFiles = [...new Set([...mr1Files, ...mr2Files])];
  const fileDiffs: FileDiffComparison[] = allFiles.map(filePath => {
    const mr1Diff = mr1Info.diffs.find(d => d.new_path === filePath);
    const mr2Diff = mr2Info.diffs.find(d => d.new_path === filePath);

    return {
      filePath,
      inMR1: !!mr1Diff,
      inMR2: !!mr2Diff,
      mr1Diff: mr1Diff?.diff,
      mr2Diff: mr2Diff?.diff,
      hasDifferences: mr1Diff?.diff !== mr2Diff?.diff
    };
  });

  // Build combined diff for AI review
  let combinedDiff = `# MR Comparison Report\n\n`;
  combinedDiff += `## MR 1: ${mr1Info.title}\n`;
  combinedDiff += `- **Branch:** ${mr1Info.source_branch} → ${mr1Info.target_branch}\n`;
  combinedDiff += `- **Author:** ${mr1Info.author}\n`;
  combinedDiff += `- **Files Changed:** ${mr1Info.diffs.length}\n\n`;

  combinedDiff += `## MR 2: ${mr2Info.title}\n`;
  combinedDiff += `- **Branch:** ${mr2Info.source_branch} → ${mr2Info.target_branch}\n`;
  combinedDiff += `- **Author:** ${mr2Info.author}\n`;
  combinedDiff += `- **Files Changed:** ${mr2Info.diffs.length}\n\n`;

  combinedDiff += `## Comparison Summary\n`;
  combinedDiff += `- **Common Files:** ${commonFiles.length}\n`;
  combinedDiff += `- **Only in MR1:** ${onlyInMR1.length}\n`;
  combinedDiff += `- **Only in MR2:** ${onlyInMR2.length}\n\n`;

  // Add files only in MR1
  if (onlyInMR1.length > 0) {
    combinedDiff += `## Files Only in MR1\n`;
    for (const file of onlyInMR1) {
      const diff = mr1Info.diffs.find(d => d.new_path === file);
      combinedDiff += `### ${file}\n\`\`\`diff\n${diff?.diff || '(no diff)'}\n\`\`\`\n\n`;
    }
  }

  // Add files only in MR2
  if (onlyInMR2.length > 0) {
    combinedDiff += `## Files Only in MR2\n`;
    for (const file of onlyInMR2) {
      const diff = mr2Info.diffs.find(d => d.new_path === file);
      combinedDiff += `### ${file}\n\`\`\`diff\n${diff?.diff || '(no diff)'}\n\`\`\`\n\n`;
    }
  }

  // Add common files with differences
  if (commonFiles.length > 0) {
    combinedDiff += `## Common Files (Side-by-Side Comparison)\n`;
    for (const file of commonFiles) {
      const mr1Diff = mr1Info.diffs.find(d => d.new_path === file);
      const mr2Diff = mr2Info.diffs.find(d => d.new_path === file);
      
      combinedDiff += `### ${file}\n`;
      combinedDiff += `#### MR1 Changes:\n\`\`\`diff\n${mr1Diff?.diff || '(no changes)'}\n\`\`\`\n`;
      combinedDiff += `#### MR2 Changes:\n\`\`\`diff\n${mr2Diff?.diff || '(no changes)'}\n\`\`\`\n\n`;
    }
  }

  return {
    mr1: {
      title: mr1Info.title,
      branch: `${mr1Info.source_branch} → ${mr1Info.target_branch}`,
      author: mr1Info.author,
      filesChanged: mr1Info.diffs.length,
      files: mr1Files
    },
    mr2: {
      title: mr2Info.title,
      branch: `${mr2Info.source_branch} → ${mr2Info.target_branch}`,
      author: mr2Info.author,
      filesChanged: mr2Info.diffs.length,
      files: mr2Files
    },
    comparison: {
      commonFiles,
      onlyInMR1,
      onlyInMR2,
      fileDiffs
    },
    combinedDiffForReview: combinedDiff
  };
}

// Helper function to fetch JSON
function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
      rejectUnauthorized: false, // For self-signed certs on internal GitLab
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON response from GitLab'));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}
