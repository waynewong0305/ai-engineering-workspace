import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev", "--workspace", "@aiew/server"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "--workspace", "@aiew/web"], { stdio: "inherit" }),
];

let shuttingDown = false;

function stop(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      stop();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });
}

