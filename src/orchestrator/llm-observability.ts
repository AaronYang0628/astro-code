import { addActiveSpanEvent, setActiveSpanAttributes } from "./telemetry.js";

export interface LlmUsage {
  model: string;
  provider?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  estimatedCostUsd?: number;
}

const DEFAULT_COST_USD_PER_1K: Record<string, { input: number; output: number }> = {
  "openai/gpt-5.3-codex": { input: 0.005, output: 0.015 }
};

function resolveRate(model: string): { input: number; output: number } | null {
  const exact = DEFAULT_COST_USD_PER_1K[model];
  if (exact) {
    return exact;
  }
  return null;
}

export function estimateLlmCostUsd(model: string, promptTokens: number, completionTokens: number): number | undefined {
  const rate = resolveRate(model);
  if (!rate) {
    return undefined;
  }
  const inputCost = (promptTokens / 1000) * rate.input;
  const outputCost = (completionTokens / 1000) * rate.output;
  return Number((inputCost + outputCost).toFixed(8));
}

export function recordLlmUsage(usage: LlmUsage): void {
  setActiveSpanAttributes({
    "astro.llm.model": usage.model,
    "astro.llm.provider": usage.provider ?? "unknown",
    "astro.llm.prompt_tokens": usage.promptTokens,
    "astro.llm.completion_tokens": usage.completionTokens,
    "astro.llm.total_tokens": usage.totalTokens,
    "astro.llm.latency_ms": usage.latencyMs,
    "astro.llm.estimated_cost_usd": usage.estimatedCostUsd ?? -1
  });
  addActiveSpanEvent("astro.llm.usage", {
    "astro.llm.model": usage.model,
    "astro.llm.prompt_tokens": usage.promptTokens,
    "astro.llm.completion_tokens": usage.completionTokens,
    "astro.llm.total_tokens": usage.totalTokens,
    "astro.llm.latency_ms": usage.latencyMs,
    "astro.llm.estimated_cost_usd": usage.estimatedCostUsd ?? -1
  });
}
