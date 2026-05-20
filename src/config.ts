import dotenv from "dotenv";

dotenv.config();

export const host = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";
export const port = Number(process.env.PORT ?? 8000);
export const maxSandboxes = 1;
export const commandTimeoutSeconds = 120;
export const sandboxEnvAllowlist = ["THREADBEAT_SMOKE_MARKER", "DEEPSEEK_API_KEY", "GITHUB_TOKEN"];
export const smokeMarker = "daytona-smoke";

export const databaseUrl = process.env.DATABASE_URL;
export const daytonaApiKey = process.env.DAYTONA_API_KEY;
export const daytonaApiUrl = process.env.DAYTONA_API_URL;
export const daytonaTarget = process.env.DAYTONA_TARGET;
