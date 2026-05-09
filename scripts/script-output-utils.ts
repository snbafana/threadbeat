export const printJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

export const skipSmoke = (message: string): never => {
  console.log(message);
  process.exit(0);
};

export function skipUnless<T>(value: T | false | null | undefined, message: string): asserts value is T {
  if (!value) skipSmoke(message);
}
