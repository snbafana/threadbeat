import type { Settings } from "./config.js";
import { DEEPSEEK_API_KEY_ENV } from "./piModels.js";

export const buildPreflightReport = (settings: Settings) => {
  const agentPiApiKeyEnv = settings.agentPiApiKeyEnv ?? DEEPSEEK_API_KEY_ENV;
  const sandboxEnv = settings.sandboxEnv ?? {};
  const sandboxEnvNames = settings.sandboxEnvNames ?? [];
  const checks = [
    {
      name: "modal_credentials",
      ok: settings.modalMode !== "live" || Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET),
      detail: settings.modalMode === "live"
        ? "Modal credentials must be configured"
        : "Modal credentials are not required in dry-run mode",
    },
    {
      name: "hosted_git",
      ok: Boolean(settings.githubOwner && settings.githubToken),
      detail: "hosted Git credentials must be configured",
    },
    {
      name: "sandbox_pi_auth",
      ok: sandboxEnvNames.includes(agentPiApiKeyEnv) && Boolean(sandboxEnv[agentPiApiKeyEnv]),
      detail: "sandbox Pi API key must be present",
    },
    {
      name: "sandbox_pi_model",
      ok: Boolean(settings.agentPiProvider && settings.agentPiModel),
      detail: "sandbox Pi provider and model must be configured",
    },
    {
      name: "agent_pi_image",
      ok: Boolean(settings.modalInstallSandboxPi || settings.modalImageCommands?.length),
      detail: settings.modalInstallSandboxPi
        ? "Modal image installs sandbox Pi"
        : "Modal image must install sandbox Pi",
    },
    {
      name: "timeouts",
      ok: positive(settings.sandboxExecTimeoutMs) && positive(settings.agentBootTimeoutMs),
      detail: "sandbox exec and agent boot timeouts must be positive",
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
};

const positive = (value: number | undefined): boolean => typeof value === "number" && value > 0;
