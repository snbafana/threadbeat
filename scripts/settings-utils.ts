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
