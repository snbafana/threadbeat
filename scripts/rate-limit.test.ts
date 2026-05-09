import assert from "node:assert/strict";

import { RateLimitGuard, githubCreateRepoRateLimitRules } from "../src/rateLimit.js";

let now = 0;
const guard = new RateLimitGuard(() => now);

assert.deepEqual(guard.check("github:create-repo:test", githubCreateRepoRateLimitRules), {
  allowed: true,
});

assert.deepEqual(guard.check("github:create-repo:test", githubCreateRepoRateLimitRules), {
  allowed: false,
  reason: "github-create-repo-per-10s limit reached",
  retryAfterMs: 10_000,
});

now = 10_000;
assert.deepEqual(guard.check("github:create-repo:test", githubCreateRepoRateLimitRules), {
  allowed: true,
});

console.log("rate limit tests passed");
