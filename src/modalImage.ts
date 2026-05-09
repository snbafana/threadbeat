export const SANDBOX_PI_NPM_PACKAGE = "@mariozechner/pi-coding-agent";

const SANDBOX_PI_IMAGE_COMMANDS = [
  "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git nodejs npm && rm -rf /var/lib/apt/lists/*",
  `RUN npm install -g ${SANDBOX_PI_NPM_PACKAGE}`,
];

export const buildModalImageCommands = (input: {
  installSandboxPi?: boolean;
  extraCommands?: string[];
}): string[] => [
  ...(input.installSandboxPi ? SANDBOX_PI_IMAGE_COMMANDS : []),
  ...(input.extraCommands ?? []),
];
