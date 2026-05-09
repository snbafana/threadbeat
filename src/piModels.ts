export const DEEPSEEK_PROVIDER = "deepseek";
export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

export const deepSeekPiModelsJson = (): string => `${JSON.stringify({
  providers: {
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: "$DEEPSEEK_API_KEY",
      models: [
        {
          id: DEEPSEEK_PRO_MODEL,
          name: "DeepSeek V4 Pro",
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          input: ["text"],
          reasoning: true,
          cost: {
            input: 1.74,
            output: 3.48,
            cacheRead: 0.145,
            cacheWrite: 0,
          },
          compat: deepSeekCompat(),
        },
        {
          id: DEEPSEEK_FLASH_MODEL,
          name: "DeepSeek V4 Flash",
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          input: ["text"],
          reasoning: true,
          cost: {
            input: 0.14,
            output: 0.28,
            cacheRead: 0.028,
            cacheWrite: 0,
          },
          compat: deepSeekCompat(),
        },
      ],
    },
  },
}, null, 2)}
`;

const deepSeekCompat = () => ({
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  reasoningEffortMap: {
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
  },
});
