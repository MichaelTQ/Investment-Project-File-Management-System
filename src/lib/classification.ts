import {
  FLAT_FILE_CATEGORIES,
  type FlatFileCategory,
} from './folder-structure';

export const KEYWORD_SCORE_THRESHOLD = 5;
export const MIN_KEYWORD_SCORE_GAP = 2;
export const LLM_CONFIDENCE_THRESHOLD = 60;

export interface KeywordMatch {
  category: FlatFileCategory;
  score: number;
  matchedKeywords: string[];
  fileNameMatches: string[];
  contentMatches: string[];
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/**
 * 同一类别中只保留最具体的命中词，避免“立项/申请/立项申请”
 * 对同一段文本重复计分，也会自动消除配置中的重复关键词。
 */
function findSpecificKeywordMatches(
  value: string,
  keywords: string[]
): string[] {
  const normalizedValue = normalize(value);
  const uniqueKeywords = Array.from(
    new Map(
      keywords
        .map(keyword => keyword.trim())
        .filter(Boolean)
        .map(keyword => [normalize(keyword), keyword] as const)
    ).values()
  );
  const matches = uniqueKeywords.filter(keyword =>
    normalizedValue.includes(normalize(keyword))
  );

  return matches.filter(keyword => {
    const normalizedKeyword = normalize(keyword);
    return !matches.some(otherKeyword => {
      const normalizedOther = normalize(otherKeyword);
      return (
        normalizedOther.length > normalizedKeyword.length &&
        normalizedOther.includes(normalizedKeyword)
      );
    });
  });
}

export function matchByKeywords(
  fileName: string,
  contentText: string,
  categories: FlatFileCategory[] = FLAT_FILE_CATEGORIES
): KeywordMatch[] {
  const results: KeywordMatch[] = [];

  for (const category of categories) {
    const fileNameMatches = findSpecificKeywordMatches(
      fileName,
      category.keywords
    );
    const contentMatches = findSpecificKeywordMatches(
      contentText,
      category.keywords
    );
    const matchedKeywords = Array.from(
      new Set([...fileNameMatches, ...contentMatches])
    );
    const score = fileNameMatches.length * 3 + contentMatches.length;

    if (score > 0) {
      results.push({
        category,
        score,
        matchedKeywords,
        fileNameMatches,
        contentMatches,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

export function assessKeywordMatches(matches: KeywordMatch[]): {
  passed: boolean;
  scoreGap: number | null;
  ambiguous: boolean;
} {
  const bestScore = matches[0]?.score ?? 0;
  const secondScore = matches[1]?.score;
  const scoreGap =
    secondScore === undefined ? null : Math.max(0, bestScore - secondScore);
  const meetsThreshold = bestScore >= KEYWORD_SCORE_THRESHOLD;
  const ambiguous =
    meetsThreshold &&
    secondScore !== undefined &&
    bestScore - secondScore < MIN_KEYWORD_SCORE_GAP;

  return {
    passed: meetsThreshold && !ambiguous,
    scoreGap,
    ambiguous,
  };
}

export function getCategoryByLlmIndex(
  value: unknown,
  categories: FlatFileCategory[] = FLAT_FILE_CATEGORIES
): { categoryIndex: number | null; category: FlatFileCategory | null } {
  const categoryIndex = Number(value);
  if (
    !Number.isInteger(categoryIndex) ||
    categoryIndex < 1 ||
    categoryIndex > categories.length
  ) {
    return { categoryIndex: null, category: null };
  }

  return {
    categoryIndex,
    category: categories[categoryIndex - 1],
  };
}

export function normalizeConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}
