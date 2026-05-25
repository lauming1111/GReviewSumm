export interface Review {
  author: string;
  rating: number;
  text: string;
  date?: string;
}

export interface SummaryResult {
  placeName: string;
  overallSentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  averageRating: number;
  totalReviews: number;
  pros: string[];
  cons: string[];
  summary: string;
  topThemes: string[];
  /** Staff/employee first names mentioned by name in multiple reviews. */
  notableStaff: string[];
}

export interface OllamaParams {
  temperature?: number;   // 0.0–2.0
  topK?: number;          // 1–200
  topP?: number;          // 0.0–1.0
  numCtx?: number;        // context window tokens
  repeatPenalty?: number; // 0.0–2.0
}

export interface ReviewSettings {
  reviewMode: 'recent' | 'all' | '1m' | '3m' | '6m' | '1y';
  reviewCount: number;
  aiProvider: 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'custom';
  // Ollama
  ollamaModel?: string;
  ollamaParams?: OllamaParams;
  // OpenAI
  openaiApiKey?: string;
  openaiModel?: string;
  // Anthropic
  anthropicApiKey?: string;
  anthropicModel?: string;
  // Google Gemini
  geminiApiKey?: string;
  geminiModel?: string;
  // Groq
  groqApiKey?: string;
  groqModel?: string;
  // Custom OpenAI-compatible endpoint
  customEndpoint?: string;
  customApiKey?: string;
  customModel?: string;
}

export interface ScrollConfig {
  tabOpenWaitMs: number;
  pollIntervalMs: number;
  scrollWaitMs: number;
  moreReviewsWaitMs: number;
  maxStableRounds: number;
}

export type MessageType =
  | { type: 'GET_BASIC_INFO' }
  | { type: 'BASIC_INFO'; payload: { placeName: string; googleRating?: number; googleReviewCount?: number; category?: string; address?: string; phone?: string } }
  | { type: 'GET_REVIEWS'; maxReviews?: number; scrollConfig?: ScrollConfig }
  | { type: 'REVIEWS_DATA'; payload: { reviews: Review[]; placeName: string; googleRating?: number; googleReviewCount?: number } }
  | { type: 'SUMMARIZE'; payload: { reviews: Review[]; placeName: string; settings: ReviewSettings; googleRating?: number; googleReviewCount?: number } }
  | { type: 'SUMMARY_RESULT'; payload: SummaryResult }
  | { type: 'GET_PROGRESS' }
  | { type: 'PROGRESS'; payload: { count: number } }
  | { type: 'STOP_REVIEWS' }
  | { type: 'ERROR'; payload: string }
  | { type: 'NO_REVIEWS' };
