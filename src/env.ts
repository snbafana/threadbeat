export const intEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
};

export const stringEnv = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

export const boolEnv = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
};
