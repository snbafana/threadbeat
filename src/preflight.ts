import type { Settings } from "./config.js";
import { DEEPSEEK_API_KEY_ENV } from "./piModels.js";

export type PreflightCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type PreflightReport = {
  ok: boolean;
  checks: PreflightCheck[];
  sandboxEnvNames: string[];
  sandboxEnvResolvedNames: string[];
  recommendedSandboxEnvNames: string[];
};

const DEFAULT_SANDBOX_AUTH_ENV = [DEEPSEEK_API_KEY_ENV];

export const buildPreflightReport = (settings: Settings): PreflightReport => {
  const sandboxEnv = settings.sandboxEnv ?? {};
  const sandboxEnvNames = settings.sandboxEnvNames ?? [];
  const sandboxEnvResolvedNames = Object.keys(sandboxEnv);
  const checks: PreflightCheck[] = [
    {
      name: "modal_credentials",
      ok: settings.modalMode !== "live" || Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET),
      detail: settings.modalMode === "live"
        ? "live Modal mode requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET"
        : "dry-run Modal mode does not require Modal credentials",
    },
    {
      name: "hosted_git",
      ok: hostedGitReady(settings),
      detail: hostedGitDetail(settings),
    },
    {
      name: "sandbox_env_allowlist",
      ok: sandboxEnvNames.includes(settings.agentPiApiKeyEnv ?? "DEEPSEEK_API_KEY"),
      detail: sandboxEnvNames.length > 0
        ? `${sandboxEnvResolvedNames.length}/${sandboxEnvNames.length} allowlisted env values are present; sandbox Pi API key env=${settings.agentPiApiKeyEnv ?? "DEEPSEEK_API_KEY"}`
        : `THREADBEAT_SANDBOX_ENV_ALLOWLIST is empty; default sandbox-agent auth expects ${DEFAULT_SANDBOX_AUTH_ENV.join(",")}`,
    },
    {
      name: "sandbox_pi_api_key",
      ok: Boolean(sandboxEnv[settings.agentPiApiKeyEnv ?? "DEEPSEEK_API_KEY"]),
      detail: `${settings.agentPiApiKeyEnv ?? "DEEPSEEK_API_KEY"} must be present in the server env and allowlisted into the sandbox`,
    },
    {
      name: "sandbox_pi_model",
      ok: Boolean(settings.agentPiProvider && settings.agentPiModel),
      detail: `sandbox Pi provider=${settings.agentPiProvider ?? "unset"}; model=${settings.agentPiModel ?? "unset"}`,
    },
    {
      name: "agent_pi_image",
      ok: Boolean(settings.modalInstallSandboxPi || settings.modalImageCommands?.length),
      detail: settings.modalInstallSandboxPi
        ? "Modal image installs sandbox Pi"
        : "set THREADBEAT_MODAL_INSTALL_SANDBOX_PI=1 or provide THREADBEAT_MODAL_IMAGE_COMMANDS",
    },
    {
      name: "timeouts",
      ok: positive(settings.sandboxExecTimeoutMs) && positive(settings.agentBootTimeoutMs),
      detail: `sandbox exec timeout=${settings.sandboxExecTimeoutMs ?? "unset"}ms; agent boot timeout=${settings.agentBootTimeoutMs ?? "unset"}ms`,
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
    sandboxEnvNames,
    sandboxEnvResolvedNames,
    recommendedSandboxEnvNames: DEFAULT_SANDBOX_AUTH_ENV,
  };
};

const hostedGitReady = (settings: Settings): boolean => {
  return Boolean(settings.githubOwner && settings.githubToken);
};

const hostedGitDetail = (settings: Settings): string => {
  return "GitHub mode requires THREADBEAT_GITHUB_OWNER and THREADBEAT_GITHUB_TOKEN/GITHUB_TOKEN";
};

const positive = (value: number | undefined): boolean => typeof value === "number" && value > 0;
