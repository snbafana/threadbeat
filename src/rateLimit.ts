export type RateLimitDecision = {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
};

export type RateLimitRule = {
  limit: number;
  name: string;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

export class RateLimitGuard {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  check(key: string, rules: RateLimitRule[]): RateLimitDecision {
    let longestRetryAfterMs = 0;
    let reason: string | undefined;
    for (const rule of rules) {
      const bucketKey = `${key}:${rule.name}`;
      const bucket = this.bucketFor(bucketKey, rule.windowMs);
      if (bucket.count >= rule.limit) {
        const retryAfterMs = Math.max(0, bucket.resetAt - this.now());
        if (retryAfterMs >= longestRetryAfterMs) {
          longestRetryAfterMs = retryAfterMs;
          reason = `${rule.name} limit reached`;
        }
      }
    }
    if (reason) return { allowed: false, reason, retryAfterMs: longestRetryAfterMs };
    for (const rule of rules) {
      this.bucketFor(`${key}:${rule.name}`, rule.windowMs).count += 1;
    }
    return { allowed: true };
  }

  private bucketFor(key: string, windowMs: number): Bucket {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (existing && existing.resetAt > now) return existing;
    const fresh = { count: 0, resetAt: now + windowMs };
    this.buckets.set(key, fresh);
    return fresh;
  }
}

export const githubCreateRepoRateLimitRules: RateLimitRule[] = [
  { limit: 1, name: "github-create-repo-per-10s", windowMs: 10_000 },
  { limit: 6, name: "github-create-repo-per-minute", windowMs: 60_000 },
];
