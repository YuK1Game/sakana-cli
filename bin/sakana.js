#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const VERSION = "0.3.0";
const DEFAULT_BASE_URL = "https://api.sakana.ai/v1";
const DEFAULT_MODEL = "fugu";
const DEFAULT_UPDATE_SOURCE = "github:YuK1Game/sakana-cli#main";
const MAX_FILE_BYTES = 40_000;
const ATTACHMENT_RE = /(?<!\S)@([^\s]+)/g;

const colors = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

function color(name, text) {
  return `${colors[name] ?? ""}${text}${colors.reset}`;
}

function usage() {
  return `sakana-cli ${VERSION}

Usage:
  sakana [options] [prompt...]
  sakana update [--source SOURCE] [--dry-run]

Options:
  --model fugu|fugu-ultra      Model to use
  --base-url URL               OpenAI-compatible API base URL
  --timeout SECONDS            Request timeout
  --version                    Show version
  -h, --help                   Show help

Interactive commands:
  /help            Show command list
  /status          Show current model, cwd, and context files
  /model NAME      Switch model: fugu or fugu-ultra
  /reset           Clear conversation history
  /add PATH        Add a file to persistent context
  /context         List persistent context files
  /clear-context   Clear persistent context files
  /quit            Exit

Attach a file once with @path/to/file in your prompt.`;
}

function updateUsage() {
  return `sakana update

Usage:
  sakana update [options]

Options:
  --source SOURCE      npm package source to install
  --dry-run            Print the npm command without running it
  -h, --help           Show help

Default source:
  ${DEFAULT_UPDATE_SOURCE}`;
}

function parseUpdateArgs(argv) {
  const args = {
    source: process.env.SAKANA_UPDATE_SOURCE || DEFAULT_UPDATE_SOURCE,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else {
      throw new Error(`Unknown update option: ${arg}`);
    }
  }

  if (!args.source) {
    throw new Error("--source must not be empty");
  }
  return args;
}

function runNpmInstallGlobal(source) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = ["install", "-g", source];

  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, npmArgs, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm exited with code ${code}`));
      }
    });
  });
}

async function runUpdate(argv) {
  let args;
  try {
    args = parseUpdateArgs(argv);
  } catch (error) {
    console.error(color("red", error.message));
    console.error(updateUsage());
    return 1;
  }

  if (args.help) {
    console.log(updateUsage());
    return 0;
  }

  const commandText = `npm install -g ${args.source}`;
  if (args.dryRun) {
    console.log(commandText);
    return 0;
  }

  console.log(`Updating sakana-cli from ${args.source}`);
  await runNpmInstallGlobal(args.source);
  console.log(color("green", "sakana-cli is up to date."));
  return 0;
}

function parseArgs(argv) {
  const args = {
    model: process.env.SAKANA_MODEL || DEFAULT_MODEL,
    baseUrl: process.env.SAKANA_BASE_URL || DEFAULT_BASE_URL,
    timeout: Number(process.env.SAKANA_TIMEOUT || "120"),
    prompt: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--version") {
      args.version = true;
    } else if (arg === "--model") {
      args.model = argv[++i];
    } else if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length);
    } else if (arg === "--base-url") {
      args.baseUrl = argv[++i];
    } else if (arg.startsWith("--base-url=")) {
      args.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--timeout") {
      args.timeout = Number(argv[++i]);
    } else if (arg.startsWith("--timeout=")) {
      args.timeout = Number(arg.slice("--timeout=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.prompt.push(arg);
    }
  }

  if (!["fugu", "fugu-ultra"].includes(args.model)) {
    throw new Error("--model must be fugu or fugu-ultra");
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error("--timeout must be a positive number");
  }
  return args;
}

function findEnvFile(cwd) {
  if (process.env.SAKANA_ENV_FILE) {
    return path.resolve(process.env.SAKANA_ENV_FILE);
  }

  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return "";
    }
    current = parent;
  }
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) {
    return null;
  }

  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "");
  }
  return [match[1], value];
}

function loadEnvFile(envFile) {
  if (!envFile || !fs.existsSync(envFile)) {
    return;
  }
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function makeSystemPrompt(cwd) {
  return [
    "あなたはCodex CLIのように、ターミナル上で開発を支援する実用的なAIアシスタントです。",
    "ユーザーはローカルのプロジェクトで作業しています。回答は簡潔に、実装・設計・デバッグに直接使える形にしてください。",
    "ファイル編集やコマンド実行が必要な場合は、具体的なコマンド、パッチ方針、注意点を示してください。",
    "不明点があれば、作業を止める前に合理的な仮定を置いて進める案を提示してください。",
    `現在の作業ディレクトリ: ${cwd}`,
  ].join("\n");
}

function expandHome(rawPath) {
  if (rawPath === "~") {
    return os.homedir();
  }
  if (rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function resolvePath(rawPath, cwd) {
  const expanded = expandHome(rawPath);
  return path.resolve(cwd, expanded);
}

function readTextFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
  const data = fs.readFileSync(filePath);
  const truncated = data.length > MAX_FILE_BYTES;
  const slice = truncated ? data.subarray(0, MAX_FILE_BYTES) : data;
  let text = slice.toString("utf8");
  if (truncated) {
    text += `\n\n[truncated after ${MAX_FILE_BYTES} bytes]`;
  }
  return text;
}

function relativeOrAbsolute(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative || ".";
  }
  return filePath;
}

function formatFileContext(paths, cwd) {
  return paths
    .map((filePath) => {
      const display = relativeOrAbsolute(filePath, cwd);
      const text = readTextFile(filePath);
      return `<file path="${display}">\n${text}\n</file>`;
    })
    .join("\n\n");
}

function collectInlineAttachments(prompt, cwd) {
  const paths = [];
  for (const match of prompt.matchAll(ATTACHMENT_RE)) {
    const filePath = resolvePath(match[1], cwd);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      paths.push(filePath);
    }
  }
  return paths;
}

function buildUserMessage(prompt, state) {
  const inlinePaths = collectInlineAttachments(prompt, state.cwd);
  const allPaths = [...state.contextFiles, ...inlinePaths];
  if (allPaths.length === 0) {
    return prompt;
  }

  try {
    const context = formatFileContext(allPaths, state.cwd);
    return `${prompt}\n\n<context>\n${context}\n</context>`;
  } catch (error) {
    console.error(color("red", `Could not read context file: ${error.message}`));
    return prompt;
  }
}

function resetMessages(state) {
  state.messages = [{ role: "system", content: state.systemPrompt }];
}

function printBanner(state, envFile) {
  const envLabel = envFile || "not found";
  console.log(color("cyan", "╭───────────────────────────────────────────────────╮"));
  console.log(`│ ${color("bold", "Sakana CLI")} ${color("dim", `v${VERSION}`)}`);
  console.log(`│ model: ${color("cyan", state.model)}`);
  console.log(`│ cwd: ${color("green", state.cwd)}`);
  console.log(`│ .env: ${color("dim", envLabel)}`);
  console.log("│");
  console.log(`│ Type ${color("bold", "/help")} for commands, ${color("bold", "/quit")} to exit.`);
  console.log(color("cyan", "╰───────────────────────────────────────────────────╯"));
}

function printHelp() {
  console.log(`Commands
/help            Show this help
/status          Show current model, cwd, and context files
/model NAME      Switch model: fugu or fugu-ultra
/reset           Clear conversation history
/add PATH        Add a file to persistent context
/context         List persistent context files
/clear-context   Clear persistent context files
/quit            Exit

You can also attach a file once with @path/to/file in your prompt.`);
}

function printStatus(state) {
  const context = state.contextFiles.length
    ? state.contextFiles.map((filePath) => `- ${filePath}`).join("\n")
    : "(none)";
  console.log(`model: ${state.model}
base_url: ${state.baseUrl}
cwd: ${state.cwd}
messages: ${state.messages.length}
context files:
${context}`);
}

function handleCommand(line, state) {
  const [command, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();

  if (command === "/quit" || command === "/exit") {
    return "quit";
  }
  if (command === "/help") {
    printHelp();
    return "handled";
  }
  if (command === "/status") {
    printStatus(state);
    return "handled";
  }
  if (command === "/reset") {
    resetMessages(state);
    console.log(color("green", "Conversation history cleared."));
    return "handled";
  }
  if (command === "/model") {
    if (!["fugu", "fugu-ultra"].includes(arg)) {
      console.error(color("red", "Usage: /model fugu|fugu-ultra"));
      return "handled";
    }
    state.model = arg;
    console.log(color("green", `Model switched to ${arg}.`));
    return "handled";
  }
  if (command === "/add") {
    if (!arg) {
      console.error(color("red", "Usage: /add PATH"));
      return "handled";
    }
    const filePath = resolvePath(arg, state.cwd);
    try {
      readTextFile(filePath);
    } catch (error) {
      console.error(color("red", `Could not add file: ${error.message}`));
      return "handled";
    }
    if (!state.contextFiles.includes(filePath)) {
      state.contextFiles.push(filePath);
    }
    console.log(`${color("green", "Added context:")} ${filePath}`);
    return "handled";
  }
  if (command === "/context") {
    if (!state.contextFiles.length) {
      console.log(color("dim", "No persistent context files."));
    } else {
      console.log(state.contextFiles.map((filePath) => `- ${filePath}`).join("\n"));
    }
    return "handled";
  }
  if (command === "/clear-context") {
    state.contextFiles = [];
    console.log(color("green", "Context cleared."));
    return "handled";
  }

  console.error(color("red", `Unknown command: ${command}`));
  return "handled";
}

async function postChatCompletion(state, signal) {
  const url = `${state.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: state.model,
      messages: state.messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  return response;
}

function parseStreamLine(line) {
  if (!line.startsWith("data:")) {
    return "";
  }
  const data = line.slice("data:".length).trim();
  if (!data || data === "[DONE]") {
    return "";
  }
  const event = JSON.parse(data);
  return event.choices?.[0]?.delta?.content || "";
}

async function streamResponse(state, userPrompt) {
  const userMessage = buildUserMessage(userPrompt, state);
  state.messages.push({ role: "user", content: userMessage });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.timeout * 1000);
  const chunks = [];

  console.log(`\n${color("bold", color("cyan", "sakana"))}`);

  try {
    const response = await postChatCompletion(state, controller.signal);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const delta = parseStreamLine(line);
        if (delta) {
          chunks.push(delta);
          process.stdout.write(delta);
        }
      }
    }

    if (buffer.trim()) {
      const delta = parseStreamLine(buffer);
      if (delta) {
        chunks.push(delta);
        process.stdout.write(delta);
      }
    }
    process.stdout.write("\n");
  } catch (error) {
    state.messages.pop();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const answer = chunks.join("");
  state.messages.push({ role: "assistant", content: answer });
  return answer;
}

async function repl(state) {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question("\n› ")).trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("/")) {
        const result = handleCommand(line, state);
        if (result === "quit") {
          return 0;
        }
        continue;
      }

      try {
        await streamResponse(state, line);
      } catch (error) {
        console.error(color("red", `Error: ${error.message}`));
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "update") {
    return runUpdate(argv.slice(1));
  }

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(color("red", error.message));
    console.error(usage());
    return 1;
  }

  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.version) {
    console.log(`sakana-cli ${VERSION}`);
    return 0;
  }

  const cwd = process.cwd();
  const envFile = findEnvFile(cwd);
  loadEnvFile(envFile);

  const apiKey = process.env.SAKANA_API_KEY;
  if (!apiKey) {
    console.error(color("red", "SAKANA_API_KEY is not set. Put it in .env or export it in your shell."));
    return 1;
  }

  const state = {
    apiKey,
    model: args.model,
    baseUrl: args.baseUrl,
    timeout: args.timeout,
    cwd,
    contextFiles: [],
    systemPrompt: makeSystemPrompt(cwd),
    messages: [],
  };
  resetMessages(state);

  const prompt = args.prompt.join(" ").trim();
  if (prompt) {
    await streamResponse(state, prompt);
    return 0;
  }

  printBanner(state, envFile);
  return repl(state);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(color("red", error.stack || error.message));
    process.exitCode = 1;
  });
