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
}

export interface ReviewSettings {
  reviewMode: 'recent' | 'all' | '1m' | '3m' | '6m' | '1y';
  reviewCount: number;
}

export type MessageType =
  | { type: 'GET_BASIC_INFO' }
  | { type: 'BASIC_INFO'; payload: { placeName: string; googleRating?: number; googleReviewCount?: number } }
  | { type: 'GET_REVIEWS'; maxReviews?: number }
  | { type: 'REVIEWS_DATA'; payload: { reviews: Review[]; placeName: string; googleRating?: number; googleReviewCount?: number } }
  | { type: 'SUMMARIZE'; payload: { reviews: Review[]; placeName: string; settings: ReviewSettings; googleRating?: number; googleReviewCount?: number } }
  | { type: 'SUMMARY_RESULT'; payload: SummaryResult }
  | { type: 'GET_PROGRESS' }
  | { type: 'PROGRESS'; payload: { count: number } }
  | { type: 'ERROR'; payload: string }
  | { type: 'NO_REVIEWS' };
