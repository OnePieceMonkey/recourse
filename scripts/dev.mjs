// Starts the whole stack with prefixed output: facilitator, publishers, agent server, web.
// Usage: node --env-file-if-exists=.env scripts/dev.mjs
import { spawn } from "node:child_process";

const services = [
  { name: "recourse ", cmd: ["pnpm", "--filter", "@recourse/facilitator", "start"], color: 35 },
  { name: "publisher", cmd: ["pnpm", "--filter", "@recourse/publisher-demo", "start"], color: 36, delay: 2500 },
  { name: "agent    ", cmd: ["pnpm", "--filter", "@recourse/agent", "start", "serve"], color: 33, delay: 2500 },
  { name: "web      ", cmd: ["pnpm", "--filter", "@recourse/web", "dev"], color: 32 },
];

const children = [];
for (const s of services) {
  setTimeout(() => {
    const child = spawn(s.cmd[0], s.cmd.slice(1), { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const prefix = `\x1b[${s.color}m${s.name}\x1b[0m │ `;
    const pipe = (stream, out) =>
      stream.on("data", (d) => out.write(d.toString().split("\n").filter(Boolean).map((l) => prefix + l).join("\n") + "\n"));
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on("exit", (code) => console.log(`${prefix}exited with ${code}`));
    children.push(child);
  }, s.delay ?? 0);
}
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
