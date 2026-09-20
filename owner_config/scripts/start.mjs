await import("./build-if-needed.mjs");

const { startServer } = await import("../dist/src/server.js");
startServer();
