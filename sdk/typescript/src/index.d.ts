export type AiStatus =
  | "success"
  | "cached_fallback"
  | "not_entitled"
  | "quota_reached"
  | "throttled"
  | "unavailable"
  | "bad_request";

export interface AiAudit {
  model?: string;
  confidence?: number | null;
  dataVersion?: string;
  promptVersion?: string;
}

export interface AiResponse<T> {
  status: AiStatus;
  value?: T;
  audit?: AiAudit;
  disclaimer?: string;
  message?: string;
  cached?: boolean;
  quota?: { monthlyQuota: number; used: number; resetAt: string };
}

export interface BoqItem {
  ref?: string;
  description: string;
  unit?: string;
  quantity?: number;
  rate?: number;
}

export interface AdlmAiClient {
  STATUS: Record<string, AiStatus>;
  rateBuildup(input: { description: string; zone?: string; unit?: string }): Promise<AiResponse<unknown>>;
  boqCheck(input: { items: BoqItem[]; zone?: string }): Promise<AiResponse<unknown>>;
  outliers(input: { items: BoqItem[] }): Promise<AiResponse<unknown>>;
  catalogueExtract(input: {
    pages: { bytes: string; mime?: string }[];
    taxonomy?: string[];
    templateColumns?: string[];
  }): Promise<AiResponse<unknown>>;
}

export function createAdlmAi(options: {
  baseUrl: string;
  getToken?: () => string;
  product?: string;
  maxRetries?: number;
  timeoutMs?: number;
}): AdlmAiClient;
