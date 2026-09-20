import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cachePath = join(root, "dist/.build-cache");
const outputs = [join(root, "dist/src/server.js"), join(root, "web-dist/index.html")];
const inputs = ["package.json", "package-lock.json", "tsconfig.json", "vite.config.ts"];

async function filesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const item = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(item));
    else if (entry.isFile()) files.push(item);
  }
  return files;
}

async function fingerprint() {
  const files = [
    ...inputs.map((file) => join(root, file)),
    ...await filesUnder(join(root, "src")),
    ...await filesUnder(join(root, "web")),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function build() {
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`build exited with code ${code}`)));
  });
}

const current = await fingerprint();
const cached = await readFile(cachePath, "utf8").catch(() => "");
const cacheHit = cached.trim() === current && (await Promise.all(outputs.map(exists))).every(Boolean);
if (!cacheHit) {
  await build();
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${current}\n`);
}
