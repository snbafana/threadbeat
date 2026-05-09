import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { DEFAULT_HOST, DEFAULT_MODAL_IMAGE, type ModalMode, type Settings } from "../src/config.js";

export const scriptSettings = (input: {
  dbUrl?: string;
  modalAppName: string;
  modalMode?: ModalMode;
  overrides?: Partial<Settings>;
  projectRoot?: string;
  tempRoot?: string;
}): Settings => ({
  projectRoot: input.projectRoot ?? path.resolve("."),
  dbUrl: input.dbUrl ?? (input.tempRoot ? `file:${path.join(input.tempRoot, "threadbeat.db")}` : "file::memory:"),
  host: DEFAULT_HOST,
  port: 0,
  modalMode: input.modalMode ?? "dry-run",
  modalAppName: input.modalAppName,
  modalImage: DEFAULT_MODAL_IMAGE,
  ...input.overrides,
});

export const createScriptTempRoot = (name: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));

export const removeScriptTempRoot = (tempRoot: string): Promise<void> =>
  fs.rm(tempRoot, { recursive: true, force: true });

export const scriptServerBaseUrl = (host: string, address: AddressInfo | string | null): string => {
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return `http://${host}:${address.port}`;
};
