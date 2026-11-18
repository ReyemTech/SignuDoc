import { lstatSync, mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

export function ensureFixtureDirectory(directory: string) {
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory()) {
    throw new Error("The fixture directory must be an ordinary directory.");
  }
}

export async function clearFixtureDirectory(directory: string) {
  ensureFixtureDirectory(directory);
  // The container binds this inode. Remove its children, including any
  // symlinks themselves, while preserving the root.
  for (const child of await readdir(directory)) {
    await rm(path.join(directory, child), { recursive: true, force: true });
  }
}
