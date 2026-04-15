import { spawn } from "node:child_process";
import process from "node:process";

const children = new Set();
let shuttingDown = false;

function launch(name, args) {
  const child = spawn("node", args, {
    stdio: "inherit",
    env: process.env
  });
  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) {
      return;
    }

    const status = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[runtime] ${name} exited with ${status}`);
    shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    children.delete(child);
    if (shuttingDown) {
      return;
    }
    console.error(`[runtime] failed to start ${name}:`, error);
    shutdown(1);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of children) {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 4_000).unref();

  if (children.size === 0) {
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

launch("worker", ["apps/worker/dist/worker.js"]);
launch("api", ["apps/api/dist/server.js"]);
