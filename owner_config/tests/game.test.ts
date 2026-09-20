import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { stringify } from "yaml";
import { gameClientOpenCommand, gameServerOpenCommand } from "../src/platform.js";
import { createApp } from "../src/server.js";

test("builds the Windows game client and server launch commands from the project path", () => {
  const environment = { WSL_DISTRO_NAME: "Ubuntu" };
  assert.deepEqual(gameClientOpenCommand("/mnt/d/code/se/other", "linux", environment), {
    command: "cmd.exe",
    args: ["/c", "cd /d D:\\code\\se\\other\\client\\bin && start game.exe"],
  });
  assert.deepEqual(gameServerOpenCommand("/mnt/d/code/se/other", "linux", environment), {
    command: "wt.exe",
    args: ["-w", "0", "nt", "--title", "GameServer", "-d", "D:\\code\\se\\other\\server\\debug", "cmd.exe", "/k", "start /b game_unite && start /b game_charge"],
  });
});

test("game launch APIs accept only projects tagged game", async (context) => {
  const codeRoot = await mkdtemp(join(tmpdir(), "owner-config-game-"));
  const root = join(codeRoot, "owner_config");
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(codeRoot, "game"), { recursive: true });
  await mkdir(join(codeRoot, "api"), { recursive: true });
  await writeFile(join(root, "data/projects.yaml"), stringify({
    env: { current: "dev", options: ["dev"] },
    projects: [
      { id: 1, name: "game", conf_dir: "game", tags: ["game"], files: [] },
      { id: 2, name: "api", conf_dir: "api", tags: [], files: [] },
    ],
  }));
  await writeFile(join(root, "data/variables.yaml"), "{}\n");
  const clientPaths: string[] = [];
  const serverPaths: string[] = [];
  const app = createApp(root, {
    gameClientOpener: async (path) => { clientPaths.push(path); },
    gameServerOpener: async (path) => { serverPaths.push(path); },
    logger: { info: () => undefined, error: () => undefined },
  }).listen(0, "127.0.0.1");
  context.after(() => app.close());
  await new Promise<void>((resolve) => app.once("listening", resolve));
  const address = app.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/api/projects/1/open-game-client`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/api/projects/1/open-game-server`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/api/projects/2/open-game-client`, { method: "POST" })).status, 400);
  assert.deepEqual(clientPaths, [join(codeRoot, "game")]);
  assert.deepEqual(serverPaths, [join(codeRoot, "game")]);
});

test("game projects replace editor and terminal actions with launch actions in details", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /workspaceProject\.tags\.includes\('game'\)[\s\S]*?启动客户端[\s\S]*?启动服务器/);
  assert.match(app, /<template v-if="workspaceProject\.tags\.includes\('game'\)"[\s\S]*?启动客户端[\s\S]*?启动服务器[\s\S]*?<template v-else>[\s\S]*?终端打开[\s\S]*?VS Code 打开[\s\S]*?Zed 打开/);
  assert.match(app, /fetch\(`\/api\/projects\/\$\{project\.id\}\/open-game-\$\{target\}`/);
});
