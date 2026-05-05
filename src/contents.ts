import fs from "node:fs/promises";
import path from "node:path";

export class ContentsLoader {
  constructor(private readonly repoRoot: string) {}

  async readMarkdown(relativePath: string): Promise<string> {
    const cleaned = relativePath.trim().replace(/^\.\/+/, "");
    if (!cleaned.endsWith(".md")) throw new Error("contents must end in .md");
    if (cleaned.startsWith("/") || cleaned.split("/").includes("..")) {
      throw new Error("contents must be a repo-relative path");
    }
    const fullPath = path.resolve(this.repoRoot, cleaned);
    if (!fullPath.startsWith(this.repoRoot + path.sep)) {
      throw new Error("contents path escapes repo root");
    }
    return fs.readFile(fullPath, "utf8");
  }
}
