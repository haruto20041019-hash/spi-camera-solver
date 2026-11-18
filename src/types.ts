export type ScreenState = 'camera' | 'analyzing' | 'result';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface SolveResult {
  status: 'solved' | 'unreadable';
  unreadableReason: string;
  questionSummary: string;
  choices: string[];
  answerLabel: string;
  answerValue: string;
  reasoning: string;
  verification: string;
  confidence: ConfidenceLevel;
}

export interface HealthResponse {
  ok: boolean;
  apiKeyConfigured: boolean;
  model: string;
}
