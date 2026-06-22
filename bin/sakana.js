#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const VERSION = "0.6.0";
const DEFAULT_BASE_URL = "https://api.sakana.ai/v1";
const DEFAULT_MODEL = "fugu";
const DEFAULT_UPDATE_SOURCE = "github:YuK1Game/sakana-cli#main";
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_FILE_BYTES = 40_000;
const MAX_COMMAND_OUTPUT_BYTES = 30_000;
const MAX_AGENT_TURNS = 20;
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
  --timeout SECONDS            Request timeout. Default: ${DEFAULT_TIMEOUT_SECONDS}
  --no-tools                   Disable local file and command tools
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
    timeout: Number(process.env.SAKANA_TIMEOUT || String(DEFAULT_TIMEOUT_SECONDS)),
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
    } else if (arg === "--no-tools") {
      args.noTools = true;
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

function findCredentialsFile() {
  const configured = process.env.SAKANA_CREDENTIALS_FILE;
  if (configured) {
    return path.resolve(expandHome(configured));
  }
  return path.join(os.homedir(), ".sakana", "credentials");
}

function parseCredentialsContent(content) {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return parsed.SAKANA_API_KEY || parsed.api_key || parsed.apiKey || "";
  }

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }
    const [key, value] = parsed;
    if (["SAKANA_API_KEY", "api_key", "apiKey"].includes(key)) {
      return value;
    }
  }

  for (const line of content.split(/\r?\n/)) {
    const raw = line.trim();
    if (raw && !raw.startsWith("#")) {
      return raw;
    }
  }
  return "";
}

function readCredentialsFile(credentialsFile) {
  if (!fs.existsSync(credentialsFile)) {
    return "";
  }
  return parseCredentialsContent(fs.readFileSync(credentialsFile, "utf8"));
}

function resolveApiKey({ shellApiKey, credentialsFile, envFile }) {
  if (shellApiKey) {
    return {
      apiKey: shellApiKey,
      source: "environment variable SAKANA_API_KEY",
    };
  }

  try {
    const credentialsApiKey = readCredentialsFile(credentialsFile);
    if (credentialsApiKey) {
      return {
        apiKey: credentialsApiKey,
        source: credentialsFile,
      };
    }
  } catch (error) {
    throw new Error(`Could not read ${credentialsFile}: ${error.message}`);
  }

  if (process.env.SAKANA_API_KEY) {
    return {
      apiKey: process.env.SAKANA_API_KEY,
      source: envFile ? `.env: ${envFile}` : "environment variable SAKANA_API_KEY",
    };
  }

  return {
    apiKey: "",
    source: "",
  };
}

function makeSystemPrompt(cwd) {
  return [
    "あなたはCodex CLIのように、ターミナル上で開発を支援する実用的なAIアシスタントです。",
    "ユーザーはローカルのプロジェクトで作業しています。必要なファイル作成、編集、検証コマンド実行は利用可能なツールで自分で行ってください。",
    "実装を依頼されたら、原則として確認待ちで止まらず、合理的な仮定を置いて作業を完了してください。",
    "ユーザーにコマンド実行やファイル作成を依頼するだけで終わらないでください。あなた自身がツールを呼び出して作業してください。",
    "作業後は、変更内容と検証結果を簡潔に報告してください。",
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

function assertInsideCwd(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the current workspace: ${filePath}`);
  }
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

function printBanner(state) {
  const credentialLabel = state.apiKeySource || "not found";
  console.log(color("cyan", "╭───────────────────────────────────────────────────╮"));
  console.log(`│ ${color("bold", "Sakana CLI")} ${color("dim", `v${VERSION}`)}`);
  console.log(`│ model: ${color("cyan", state.model)}`);
  console.log(`│ cwd: ${color("green", state.cwd)}`);
  console.log(`│ credentials: ${color("dim", credentialLabel)}`);
  console.log(`│ tools: ${state.toolsEnabled ? color("green", "enabled") : color("dim", "disabled")}`);
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
credentials: ${state.apiKeySource || "(none)"}
tools: ${state.toolsEnabled ? "enabled" : "disabled"}
messages: ${state.messages.length}
context files:
${context}`);
}

function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files under a path inside the current workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path relative to the current workspace." },
            max_depth: { type: "number", description: "Maximum directory depth to traverse. Default 2." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file inside the current workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the current workspace." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a UTF-8 text file inside the current workspace. Parent directories are created automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the current workspace." },
            content: { type: "string", description: "Complete file content to write." },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command in the current workspace and return stdout/stderr. Use for setup, tests, builds, and inspections.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run." },
            timeout_seconds: { type: "number", description: "Timeout in seconds. Default 60, max 300." },
          },
          required: ["command"],
        },
      },
    },
  ];
}

function parseToolArguments(rawArguments) {
  if (!rawArguments) {
    return {};
  }
  if (typeof rawArguments === "object") {
    return rawArguments;
  }
  return JSON.parse(rawArguments);
}

function isDeniedCommand(command) {
  const deniedPatterns = [
    /\brm\s+-[^&|;]*r[^&|;]*f\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+checkout\s+--\s+/,
    /\bsudo\b/,
    />\s*\/dev\/sd[a-z]/,
  ];
  return deniedPatterns.some((pattern) => pattern.test(command));
}

function truncateOutput(text, maxBytes = MAX_COMMAND_OUTPUT_BYTES) {
  const data = Buffer.from(String(text));
  if (data.length <= maxBytes) {
    return String(text);
  }
  return `${data.subarray(0, maxBytes).toString("utf8")}\n[truncated after ${maxBytes} bytes]`;
}

function truncateDisplay(text, maxLength = 120) {
  const value = String(text ?? "");
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function quoteDisplay(text) {
  return JSON.stringify(truncateDisplay(text));
}

function summarizeToolCall(name, args, state) {
  if (name === "list_files") {
    return `path=${quoteDisplay(args.path || ".")} max_depth=${args.max_depth ?? 2}`;
  }
  if (name === "read_file") {
    return `path=${quoteDisplay(args.path)}`;
  }
  if (name === "write_file") {
    const bytes = Buffer.byteLength(args.content || "", "utf8");
    return `path=${quoteDisplay(args.path)} bytes=${bytes}`;
  }
  if (name === "run_command") {
    return `command=${quoteDisplay(args.command)} timeout=${args.timeout_seconds ?? 60}s cwd=${quoteDisplay(state.cwd)}`;
  }
  return "";
}

function summarizeToolResult(name, result) {
  if (name === "run_command") {
    try {
      const parsed = JSON.parse(result);
      const stderr = parsed.stderr ? ` stderr=${Buffer.byteLength(parsed.stderr, "utf8")}B` : "";
      const stdout = parsed.stdout ? ` stdout=${Buffer.byteLength(parsed.stdout, "utf8")}B` : "";
      const signal = parsed.signal ? ` signal=${parsed.signal}` : "";
      return `exit_code=${parsed.exit_code}${signal}${stdout}${stderr}`;
    } catch {
      return truncateDisplay(result);
    }
  }
  if (name === "list_files") {
    const count = result && result !== "(empty)" ? String(result).split("\n").length : 0;
    return `${count} item(s)`;
  }
  if (name === "read_file") {
    return `${Buffer.byteLength(result || "", "utf8")} bytes`;
  }
  return truncateDisplay(result);
}

function describeError(error, state, context) {
  if (error?.name === "AbortError") {
    return `${context} timed out after ${state.timeout}s. Try continuing, or start sakana with --timeout ${Math.max(state.timeout * 2, DEFAULT_TIMEOUT_SECONDS)}.`;
  }
  return error?.message || String(error);
}

function listFilesTool(args, state) {
  const start = resolvePath(args.path || ".", state.cwd);
  assertInsideCwd(start, state.cwd);
  if (!fs.existsSync(start)) {
    throw new Error(`Path does not exist: ${args.path || "."}`);
  }
  const maxDepth = Math.max(0, Math.min(Number(args.max_depth ?? 2), 8));
  const results = [];

  function walk(current, depth) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => ![".git", "node_modules", ".venv", "dist"].includes(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const relative = relativeOrAbsolute(entryPath, state.cwd);
      results.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory() && depth < maxDepth) {
        walk(entryPath, depth + 1);
      }
    }
  }

  const stat = fs.statSync(start);
  if (stat.isDirectory()) {
    walk(start, 0);
  } else {
    results.push(relativeOrAbsolute(start, state.cwd));
  }

  return results.join("\n") || "(empty)";
}

function readFileTool(args, state) {
  const filePath = resolvePath(args.path, state.cwd);
  assertInsideCwd(filePath, state.cwd);
  return readTextFile(filePath);
}

function writeFileTool(args, state) {
  const filePath = resolvePath(args.path, state.cwd);
  assertInsideCwd(filePath, state.cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, args.content, "utf8");
  return `wrote ${relativeOrAbsolute(filePath, state.cwd)} (${Buffer.byteLength(args.content, "utf8")} bytes)`;
}

function runCommandTool(args, state) {
  const command = args.command;
  if (!command || typeof command !== "string") {
    throw new Error("command must be a non-empty string");
  }
  if (isDeniedCommand(command)) {
    throw new Error(`Refusing potentially destructive command: ${command}`);
  }

  const timeoutSeconds = Math.max(1, Math.min(Number(args.timeout_seconds ?? 60), 300));
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: state.cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(JSON.stringify({
        command,
        exit_code: code,
        signal,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      }));
    });
  });
}

async function executeToolCall(toolCall, state) {
  const name = toolCall.function?.name;
  const args = parseToolArguments(toolCall.function?.arguments || "{}");
  console.log(color("dim", `tool: ${name} ${summarizeToolCall(name, args, state)}`.trim()));

  let result;

  if (name === "list_files") {
    result = listFilesTool(args, state);
  } else if (name === "read_file") {
    result = readFileTool(args, state);
  } else if (name === "write_file") {
    result = writeFileTool(args, state);
  } else if (name === "run_command") {
    result = await runCommandTool(args, state);
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }

  console.log(color("dim", `ok: ${name} ${summarizeToolResult(name, result)}`.trim()));
  return result;
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

async function postAgentCompletion(state, signal) {
  const url = `${state.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: state.model,
    messages: state.messages,
    stream: false,
  };
  if (state.toolsEnabled) {
    body.tools = getToolDefinitions();
    body.tool_choice = "auto";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${responseBody}`);
  }
  return response.json();
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
    throw new Error(describeError(error, state, "Chat request"));
  } finally {
    clearTimeout(timer);
  }

  const answer = chunks.join("");
  state.messages.push({ role: "assistant", content: answer });
  return answer;
}

async function agentResponse(state, userPrompt) {
  const userMessage = buildUserMessage(userPrompt, state);
  state.messages.push({ role: "user", content: userMessage });

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), state.timeout * 1000);
    let completion;

    try {
      console.log(color("dim", `agent: turn ${turn + 1}/${MAX_AGENT_TURNS} waiting for ${state.model}...`));
      completion = await postAgentCompletion(state, controller.signal);
    } catch (error) {
      throw new Error(describeError(error, state, "Agent request"));
    } finally {
      clearTimeout(timer);
    }

    const message = completion.choices?.[0]?.message;
    if (!message) {
      throw new Error("No assistant message in API response");
    }

    const toolCalls = message.tool_calls || [];
    state.messages.push({
      role: "assistant",
      content: message.content || "",
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (!toolCalls.length) {
      const answer = message.content || "";
      if (answer) {
        console.log(`\n${color("bold", color("cyan", "sakana"))}`);
        console.log(answer);
      }
      return answer;
    }

    console.log(color("dim", `agent: ${toolCalls.length} tool call(s) requested`));
    for (const toolCall of toolCalls) {
      let result;
      try {
        result = await executeToolCall(toolCall, state);
      } catch (error) {
        result = `Tool error: ${error.message}`;
        console.error(color("red", result));
      }
      state.messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: String(result),
      });
    }
  }

  throw new Error(`Stopped after ${MAX_AGENT_TURNS} tool turns`);
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
        if (state.toolsEnabled) {
          await agentResponse(state, line);
        } else {
          await streamResponse(state, line);
        }
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
  const shellApiKey = process.env.SAKANA_API_KEY;
  const credentialsFile = findCredentialsFile();
  const envFile = findEnvFile(cwd);
  loadEnvFile(envFile);

  let apiKeyInfo;
  try {
    apiKeyInfo = resolveApiKey({ shellApiKey, credentialsFile, envFile });
  } catch (error) {
    console.error(color("red", error.message));
    return 1;
  }

  if (!apiKeyInfo.apiKey) {
    console.error(
      color(
        "red",
        `SAKANA_API_KEY is not set. Put it in ${credentialsFile} or export it in your shell.`,
      ),
    );
    return 1;
  }

  const state = {
    apiKey: apiKeyInfo.apiKey,
    apiKeySource: apiKeyInfo.source,
    model: args.model,
    baseUrl: args.baseUrl,
    timeout: args.timeout,
    toolsEnabled: !args.noTools,
    cwd,
    contextFiles: [],
    systemPrompt: makeSystemPrompt(cwd),
    messages: [],
  };
  resetMessages(state);

  const prompt = args.prompt.join(" ").trim();
  if (prompt) {
    if (state.toolsEnabled) {
      await agentResponse(state, prompt);
    } else {
      await streamResponse(state, prompt);
    }
    return 0;
  }

  printBanner(state);
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
