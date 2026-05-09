import assert from "node:assert/strict";

import { buildModalImageCommands, SANDBOX_PI_NPM_PACKAGE } from "../src/modalImage.js";

assert.deepEqual(buildModalImageCommands({}), []);

assert.deepEqual(buildModalImageCommands({ extraCommands: ["RUN echo custom"] }), ["RUN echo custom"]);

const piCommands = buildModalImageCommands({
  installSandboxPi: true,
  extraCommands: ["RUN echo after"],
});

assert.ok(piCommands.some((command) => command.includes("apt-get install")));
assert.ok(piCommands.some((command) => command.includes(`npm install -g ${SANDBOX_PI_NPM_PACKAGE}`)));
assert.equal(piCommands.at(-1), "RUN echo after");

console.log("modal image tests passed");
