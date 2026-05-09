export const nowIso = (): string => new Date().toISOString();

export const nextTickIso = (cadenceSeconds: number, status: string): string | null => {
  if (status !== "active") return null;
  return new Date(Date.now() + cadenceSeconds * 1000).toISOString();
};
