export const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
};

export const csvEnv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

export const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
