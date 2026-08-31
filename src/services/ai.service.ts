import Groq from "groq-sdk";

const apiKey = process.env.GROQ_API_KEY || "";

if (!apiKey) {
  console.warn("⚠️  WARNING: GROQ_API_KEY is not set! AI reviews will fail.");
  console.warn("   Get a free key at: https://console.groq.com");
}

const groq = new Groq({ apiKey });

// Max characters to send in a single request (roughly ~4 chars per token, keeping buffer)
const MAX_CHARS_PER_REQUEST = 8000;

export interface CodeIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  type: "security" | "performance" | "best-practice" | "bug" | "style";
  title: string;
  description: string;
  lineNumber?: number;
  suggestion: string;
  codeSnippet?: string;
  filePath?: string; // Added for MR reviews
}

export interface ReviewResult {
  summary: string;
  issues: CodeIssue[];
  suggestions: string[];
  metrics: {
    critical: number;
    warning: number;
    info: number;
  };
  githubComments: GitHubComment[];
  chunksReviewed?: number; // Indicates if review was done in chunks
}

export interface GitHubComment {
  path?: string;
  line?: number;
  body: string;
  severity: "critical" | "warning" | "info";
}

const REVIEW_PROMPT = `You are an expert code reviewer. Analyze the following code and provide a detailed review.

Your review should include:
1. A brief summary of what the code does
2. Identified issues with severity levels (critical, warning, info)
3. Issue types: security, performance, best-practice, bug, style
4. Specific suggestions for improvements
5. GitHub PR-style comments

Respond in the following JSON format ONLY (no markdown, no code blocks, just pure JSON):
{
  "summary": "Brief description of what the code does",
  "issues": [
    {
      "id": "unique-id",
      "severity": "critical|warning|info",
      "type": "security|performance|best-practice|bug|style",
      "title": "Short issue title",
      "description": "Detailed description of the issue",
      "lineNumber": null,
      "suggestion": "How to fix this issue",
      "codeSnippet": "relevant code if applicable"
    }
  ],
  "suggestions": [
    "General improvement suggestion 1",
    "General improvement suggestion 2"
  ],
  "githubComments": [
    {
      "line": null,
      "body": "GitHub-style review comment",
      "severity": "critical|warning|info"
    }
  ]
}

Code Language: {{LANGUAGE}}
Review Type: {{REVIEW_TYPE}}

Code to review:
\`\`\`
{{CODE}}
\`\`\``;

/**
 * Split large diff content into smaller chunks based on file boundaries
 */
function splitIntoChunks(code: string, maxChars: number): string[] {
  // If code is small enough, return as single chunk
  if (code.length <= maxChars) {
    return [code];
  }

  const chunks: string[] = [];

  // Try to split by file markers (### [NEW/MODIFIED/DELETED])
  const fileMarkerRegex = /### \[(NEW|MODIFIED|DELETED)\]/g;
  const fileMarkers: number[] = [];
  let match;

  while ((match = fileMarkerRegex.exec(code)) !== null) {
    fileMarkers.push(match.index);
  }

  // If we found file markers, split by files
  if (fileMarkers.length > 1) {
    let currentChunk = "";
    let headerInfo = "";

    // Extract header info (MR title, branch info, description) if present
    const firstMarker = fileMarkers[0];
    if (firstMarker > 0) {
      headerInfo = code.substring(0, Math.min(firstMarker, 500)); // Keep header short
    }

    for (let i = 0; i < fileMarkers.length; i++) {
      const start = fileMarkers[i];
      const end = i < fileMarkers.length - 1 ? fileMarkers[i + 1] : code.length;
      const fileContent = code.substring(start, end);

      // If adding this file would exceed limit, save current chunk and start new one
      if (
        currentChunk.length + fileContent.length > maxChars &&
        currentChunk.length > 0
      ) {
        chunks.push(
          headerInfo +
            "\n## Changes (Part " +
            chunks.length +
            ")\n\n" +
            currentChunk,
        );
        currentChunk = "";
      }

      // If single file is too large, truncate it
      if (fileContent.length > maxChars) {
        const truncatedFile =
          fileContent.substring(0, maxChars - 500) +
          "\n\n[... truncated due to size ...]\n";
        if (currentChunk.length > 0) {
          chunks.push(
            headerInfo +
              "\n## Changes (Part " +
              chunks.length +
              ")\n\n" +
              currentChunk,
          );
          currentChunk = "";
        }
        chunks.push(
          headerInfo +
            "\n## Changes (Part " +
            chunks.length +
            ")\n\n" +
            truncatedFile,
        );
      } else {
        currentChunk += fileContent;
      }
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push(
        headerInfo +
          "\n## Changes (Part " +
          chunks.length +
          ")\n\n" +
          currentChunk,
      );
    }
  } else {
    // No file markers found, split by character count
    for (let i = 0; i < code.length; i += maxChars) {
      chunks.push(code.substring(i, Math.min(i + maxChars, code.length)));
    }
  }

  return chunks.length > 0 ? chunks : [code.substring(0, maxChars)];
}

/**
 * Perform a single AI review request
 */
async function performSingleReview(
  code: string,
  language: string,
  reviewType: "snippet" | "diff",
  chunkInfo?: string,
): Promise<ReviewResult> {
  const prompt = REVIEW_PROMPT.replace("{{LANGUAGE}}", language)
    .replace(
      "{{REVIEW_TYPE}}",
      reviewType === "diff" ? "PR Diff" : "Code Snippet",
    )
    .replace("{{CODE}}", code);

  console.log(`Sending request to Groq API... ${chunkInfo || ""}`);

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "You are an expert code reviewer. Always respond with valid JSON only, no markdown formatting.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    model: "openai/gpt-oss-20b",
    temperature: 0.3,
    max_tokens: 4096,
  });

  const text = chatCompletion.choices[0]?.message?.content || "";
  console.log("Received response from Groq API");

  // Clean the response - remove any markdown code blocks if present
  let cleanedText = text.trim();
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.slice(7);
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.slice(3);
  }
  if (cleanedText.endsWith("```")) {
    cleanedText = cleanedText.slice(0, -3);
  }
  cleanedText = cleanedText.trim();

  const parsed = JSON.parse(cleanedText) as ReviewResult;

  return parsed;
}

/**
 * Merge multiple review results into one
 */
function mergeReviewResults(results: ReviewResult[]): ReviewResult {
  const allIssues: CodeIssue[] = [];
  const allSuggestions: string[] = [];
  const allComments: GitHubComment[] = [];
  const summaries: string[] = [];

  let issueCounter = 1;

  for (const result of results) {
    summaries.push(result.summary);

    // Add issues with unique IDs
    for (const issue of result.issues || []) {
      allIssues.push({
        ...issue,
        id: `issue-${issueCounter++}`,
      });
    }

    allSuggestions.push(...(result.suggestions || []));
    allComments.push(...(result.githubComments || []));
  }

  // Deduplicate suggestions
  const uniqueSuggestions = [...new Set(allSuggestions)];

  // Calculate metrics
  const metrics = {
    critical: allIssues.filter((i) => i.severity === "critical").length,
    warning: allIssues.filter((i) => i.severity === "warning").length,
    info: allIssues.filter((i) => i.severity === "info").length,
  };

  // Create combined summary
  const combinedSummary =
    results.length === 1
      ? summaries[0]
      : `Review of ${results.length} parts:\n\n${summaries.map((s, i) => `**Part ${i + 1}:** ${s}`).join("\n\n")}`;

  return {
    summary: combinedSummary,
    issues: allIssues,
    suggestions: uniqueSuggestions.slice(0, 10), // Limit suggestions
    metrics,
    githubComments: allComments,
    chunksReviewed: results.length,
  };
}

export async function reviewCode(
  code: string,
  language: string,
  reviewType: "snippet" | "diff",
): Promise<ReviewResult> {
  try {
    // Check if we need to chunk the code
    const chunks = splitIntoChunks(code, MAX_CHARS_PER_REQUEST);

    if (chunks.length === 1) {
      // Single chunk - simple case
      const result = await performSingleReview(code, language, reviewType);

      // Calculate metrics
      const metrics = {
        critical:
          result.issues?.filter((i) => i.severity === "critical").length || 0,
        warning:
          result.issues?.filter((i) => i.severity === "warning").length || 0,
        info: result.issues?.filter((i) => i.severity === "info").length || 0,
      };

      console.log(
        `Review completed: ${metrics.critical} critical, ${metrics.warning} warnings, ${metrics.info} info`,
      );

      return {
        ...result,
        metrics,
      };
    }

    // Multiple chunks - review each and merge
    console.log(
      `Large code detected. Splitting into ${chunks.length} chunks for review...`,
    );

    const results: ReviewResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        console.log(`Reviewing chunk ${i + 1}/${chunks.length}...`);
        const result = await performSingleReview(
          chunks[i],
          language,
          reviewType,
          `(Chunk ${i + 1}/${chunks.length})`,
        );
        results.push(result);

        // Small delay between chunks to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (chunkError: any) {
        console.error(`Error reviewing chunk ${i + 1}:`, chunkError.message);
        // Continue with other chunks even if one fails
        results.push({
          summary: `Chunk ${i + 1} could not be reviewed due to an error.`,
          issues: [],
          suggestions: [],
          metrics: { critical: 0, warning: 0, info: 0 },
          githubComments: [],
        });
      }
    }

    // Merge all results
    const mergedResult = mergeReviewResults(results);

    console.log(
      `Chunked review completed: ${mergedResult.metrics.critical} critical, ${mergedResult.metrics.warning} warnings, ${mergedResult.metrics.info} info`,
    );

    return mergedResult;
  } catch (error: any) {
    console.error("AI Review Error:", error?.message || error);

    // Return a fallback response if AI fails
    return {
      summary: "Unable to complete AI review. Please try again.",
      issues: [],
      suggestions: [
        "Please ensure your code is properly formatted and try again.",
      ],
      metrics: { critical: 0, warning: 0, info: 0 },
      githubComments: [],
    };
  }
}

export function detectLanguage(code: string): string {
  // Simple language detection based on patterns
  const patterns: Record<string, RegExp[]> = {
    javascript: [/\bconst\b/, /\blet\b/, /\bfunction\b/, /=>/, /console\.log/],
    typescript: [
      /:\s*(string|number|boolean|any)/,
      /interface\s+\w+/,
      /type\s+\w+\s*=/,
      /<\w+>/,
    ],
    python: [/\bdef\s+\w+/, /\bimport\s+\w+/, /:\s*$/, /\bself\b/, /__init__/],
    java: [/\bpublic\s+class\b/, /\bprivate\b/, /\bvoid\b/, /System\.out/],
    go: [/\bfunc\s+\w+/, /\bpackage\s+\w+/, /\bgo\s+func/, /fmt\.Print/],
    rust: [/\bfn\s+\w+/, /\blet\s+mut\b/, /\bimpl\b/, /println!/],
    cpp: [/#include\s*</, /\bstd::/, /\bcout\b/, /\bvector</],
    csharp: [
      /\bnamespace\b/,
      /\busing\s+System/,
      /\bpublic\s+void\b/,
      /Console\.Write/,
    ],
    php: [/<\?php/, /\$\w+/, /function\s+\w+\s*\(/, /\becho\b/],
    ruby: [/\bdef\s+\w+/, /\bend\b/, /\bputs\b/, /\brequire\b/],
    sql: [/\bSELECT\b/i, /\bFROM\b/i, /\bWHERE\b/i, /\bINSERT\b/i],
    html: [/<html/i, /<div/i, /<head/i, /<body/i],
    css: [/\{[^}]*:[^}]*\}/, /@media/, /\.[\w-]+\s*\{/],
  };

  for (const [lang, regexes] of Object.entries(patterns)) {
    const matches = regexes.filter((r) => r.test(code)).length;
    if (matches >= 2) {
      return lang;
    }
  }

  return "unknown";
}
