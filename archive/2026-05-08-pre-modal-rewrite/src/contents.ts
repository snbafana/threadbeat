import fs from "node:fs/promises";
import path from "node:path";

import { parseContentsPath } from "./validation.js";

export class ContentsLoader {
  constructor(private readonly repoRoot: string) {}

  async readMarkdown(relativePath: string): Promise<string> {
    const cleaned = parseContentsPath(relativePath);
    const fullPath = path.resolve(this.repoRoot, cleaned);
    if (!fullPath.startsWith(this.repoRoot + path.sep)) {
      throw new Error("contents path escapes repo root");
    }
    return fs.readFile(fullPath, "utf8");
  }
}
