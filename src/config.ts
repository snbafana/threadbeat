import "dotenv/config";

import path from "node:path";
import { intEnv, stringEnv } from "./env.js";

export type ModalMode = "dry-run" | "live";

export type Settings = {
  projectRoot: string;
  dbUrl: string;
  host: string;
  port: number;
  modalMode: ModalMode;
  modalAppName: string;
  modalImage: string;
};

export const loadSettings = (): Settings => {
  const projectRoot = process.cwd();
  const modalMode = stringEnv("THREADBEAT_MODAL_MODE", "dry-run");
  if (modalMode !== "dry-run" && modalMode !== "live") {
    throw new Error("THREADBEAT_MODAL_MODE must be dry-run or live");
  }

  return {
    projectRoot,
    dbUrl: stringEnv(
      "THREADBEAT_DB_URL",
      `file:${path.join(projectRoot, ".threadbeat", "threadbeat.db")}`,
    ),
    host: stringEnv("THREADBEAT_HOST", "127.0.0.1"),
    port: intEnv("THREADBEAT_PORT", intEnv("PORT", 8000)),
    modalMode,
    modalAppName: stringEnv("THREADBEAT_MODAL_APP_NAME", "threadbeat-sandboxes"),
    modalImage: stringEnv("THREADBEAT_MODAL_IMAGE", "python:3.13-slim"),
  };
};
