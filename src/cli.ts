#!/usr/bin/env bun
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import { connectGmail, createGmailSource } from "./gmail";
import { connectLark, createLarkSource } from "./lark";
import { runOnce } from "./core";
import { openState, readSecret, writeSecret } from "./state";
import { initWorkflow, loadWorkflow, type Provider } from "./workflow";

type Output = Record<string, unknown>;

const exitCodes: Record<string, number> = { CONFIG: 2, SOURCE: 3, JEV: 4, ACTION: 5, RUN_BUSY: 6, INTERNAL: 1 };

const help = {
  name: "hafi",
  status: "development",
  commands: [
    { command: "init --source gmail|lark --workflow <file>", effect: "write workflow YAML" },
    { command: "connect gmail|lark|jev", effect: "store local credentials" },
    { command: "workflow validate <file>", effect: "read YAML only" },
    { command: "doctor --workflow <file>", effect: "check local prerequisites" },
    { command: "run-once --workflow <file> [--dry-run]", effect: "read inbox; normal run may save a local draft" },
    { command: "results --workflow <id>", effect: "read local draft results; sensitive output" },
    { command: "status --workflow <id>", effect: "read local run status" },
    { command: "schedule print --workflow <file> --platform cron", effect: "prepare a private log and print a cron entry; does not install it" },
  ],
};

/** Return the value following one named flag or fail on a missing value. */
function option(args: string[], flag: string, fallback?: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${flag}`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

/** Quote an absolute path for a POSIX cron command. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Read a secret from redirected stdin or a terminal without echoing it. */
async function readHiddenLine(): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  process.stderr.write("Jev API key: ");
  const input = process.stdin;
  input.setRawMode(true);
  input.resume();
  return await new Promise<string>((resolveLine, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolveLine(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("Cancelled"));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else if (byte >= 32 && value.length < 4096) value += String.fromCharCode(byte);
      }
    };
    input.on("data", onData);
  });
}

/** Print a cron entry with absolute binary, workflow, composer, and log paths. */
function printCronSchedule(path: string, minutes: number): string {
  const binary = resolve(process.execPath);
  const composer = Bun.which("codex");
  if (!composer) throw new Error("Codex CLI is not on PATH");
  const paths = Array.from(new Set([dirname(binary), dirname(composer), "/usr/bin", "/bin"]));
  const schedule = minutes === 60 ? "0 * * * *" : `*/${minutes} * * * *`;
  const dir = resolve(homedir(), ".local", "share", "hafi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const log = resolve(dir, "cron.log");
  closeSync(openSync(log, "a", 0o600));
  chmodSync(log, 0o600);
  return `PATH=${quote(paths.join(":"))}\n${schedule} ${quote(binary)} run-once --workflow ${quote(resolve(path))} --json >> ${quote(log)} 2>&1`;
}

/** Run one CLI command and return one structured result. */
export async function command(args: string[]): Promise<Output> {
  const [name, subcommand] = args;
  if (!name || name === "help" || name === "--help") return help;
  if (name === "init") {
    const provider = option(args, "--source") as Provider;
    if (provider !== "gmail" && provider !== "lark") throw new Error("Unsupported source");
    const path = option(args, "--workflow");
    await initWorkflow(path, provider, "personal");
    return { ok: true, workflow: resolve(path), next: `hafi connect ${provider}` };
  }
  if (name === "connect") {
    if (subcommand === "gmail") return await connectGmail(option(args, "--account", "personal"));
    if (subcommand === "lark") return await connectLark(option(args, "--account", "personal"));
    if (subcommand === "jev") {
      const key = await readHiddenLine();
      if (!key) throw new Error("An API key is required");
      await writeSecret("jev-api-key", key);
      return { provider: "jev", connected: true };
    }
    throw new Error("Use connect gmail, lark, or jev");
  }
  if (name === "workflow" && subcommand === "validate") {
    const path = args[2];
    if (!path || path.startsWith("--")) throw new Error("Missing workflow file");
    const workflow = await loadWorkflow(path);
    return { ok: true, id: workflow.id, sources: workflow.sources, action: workflow.actions[0].type };
  }
  if (name === "doctor") {
    const workflow = await loadWorkflow(option(args, "--workflow"));
    const jev = Boolean(await readSecret("jev-api-key"));
    const codex = Bun.which("codex");
    const sources = await Promise.all(workflow.sources.map(async (source) => {
      try {
        if (source.provider === "gmail") await createGmailSource(source.account);
        else await createLarkSource(source.account);
        return { ...source, connected: true };
      } catch {
        return { ...source, connected: false };
      }
    }));
    const ok = jev && Boolean(codex) && sources.every((source) => source.connected);
    return { ok, code: ok ? undefined : "CONFIG", workflow: workflow.id, sources, jevConnected: jev, codexPath: codex };
  }
  if (name === "run-once") return await runOnce(option(args, "--workflow"), { dryRun: args.includes("--dry-run") });
  if (name === "results" || name === "status") {
    const workflowId = option(args, "--workflow");
    const state = openState();
    try {
      return name === "results" ? { workflow: workflowId, results: state.results(workflowId) } : { workflow: workflowId, status: state.status(workflowId) };
    } finally { state.close(); }
  }
  if (name === "schedule" && subcommand === "print") {
    if (option(args, "--platform") !== "cron") throw new Error("Only cron is supported");
    const path = option(args, "--workflow");
    const workflow = await loadWorkflow(path);
    return { workflow: workflow.id, cron: printCronSchedule(path, workflow.schedule.every_minutes) };
  }
  throw new Error(`Unknown command: ${name}`);
}

/** Render a CLI result once, keeping JSON stdout free of diagnostics. */
export async function main(args = process.argv.slice(2)): Promise<number> {
  const json = args.includes("--json");
  try {
    const result = await command(args);
    const failure = result.ok === false ? classifyFailure(String(result.errorCode ?? result.code ?? "INTERNAL")) : null;
    if (failure) result.code = failure;
    const rendered = json ? JSON.stringify(result)
      : typeof result.cron === "string" ? result.cron
      : JSON.stringify(result, null, 2);
    process.stdout.write(`${rendered}\n`);
    return failure ? exitCodes[failure] : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const code = classifyFailure(message);
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
    else process.stderr.write(`Hafi ${code}: ${code === "CONFIG" ? message : "Run failed; check hafi status for a safe error code."}\n`);
    return exitCodes[code];
  }
}

/** Map known failure prefixes to stable CLI exit categories without printing provider details. */
function classifyFailure(message: string): keyof typeof exitCodes {
  if (message in exitCodes) return message;
  if (/Missing|Unsupported|Unknown|already exists|invalid|NOT_CONFIGURED|^Set HAFI_|not connected/i.test(message)) return "CONFIG";
  if (/RUN_BUSY|busy/i.test(message)) return "RUN_BUSY";
  if (/^JEV_/i.test(message)) return "JEV";
  if (/^CODEX_|^ACTION_/i.test(message)) return "ACTION";
  if (/^SOURCE_|Gmail|Lark|OAuth|credential/i.test(message)) return "SOURCE";
  return "INTERNAL";
}

if (import.meta.main) process.exitCode = await main();
