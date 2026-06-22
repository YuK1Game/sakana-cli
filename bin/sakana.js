#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import readlinePromises from "node:readline/promises";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const VERSION = "0.10.0";
const DEFAULT_BASE_URL = "https://api.sakana.ai/v1";
const DEFAULT_MODEL = "fugu";
const DEFAULT_UPDATE_SOURCE = "github:YuK1Game/sakana-cli#main";
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_RETRIES = 2;
const MAX_FILE_BYTES = 40_000;
const MAX_COMMAND_OUTPUT_BYTES = 30_000;
const MAX_AGENT_TURNS = 20;
const ATTACHMENT_RE = /(?<!\S)@([^\s]+)/g;
const SLASH_COMMANDS = [
  { name: "/help", description: "Show command list" },
  { name: "/init", description: "Create AGENTS.md in the current workspace" },
  { name: "/status", description: "Show current settings" },
  { name: "/model", description: "Switch model: fugu or fugu-ultra" },
  { name: "/reset", description: "Clear conversation history" },
  { name: "/add", description: "Add a file to persistent context" },
  { name: "/context", description: "List persistent context files" },
  { name: "/clear-context", description: "Clear persistent context files" },
  { name: "/quit", description: "Exit" },
  { name: "/exit", description: "Exit" },
];

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
  sakana resume [options] [prompt...]
  sakana update [--source SOURCE] [--dry-run]

Options:
  --model fugu|fugu-ultra      Model to use
  --base-url URL               OpenAI-compatible API base URL
  --timeout SECONDS            Request timeout. Default: ${DEFAULT_TIMEOUT_SECONDS}
  --retries COUNT              Retries for temporary API failures. Default: ${DEFAULT_RETRIES}
  --session ID                 Resume a specific saved session
  --no-tools                   Disable local file and command tools
  --no-agents                  Do not auto-load AGENTS.md instructions
  --version                    Show version
  -h, --help                   Show help

Interactive commands:
  /help            Show command list
  /init            Create AGENTS.md in the current workspace
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
    retries: Number(process.env.SAKANA_RETRIES || String(DEFAULT_RETRIES)),
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
      args.modelSpecified = true;
    } else if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length);
      args.modelSpecified = true;
    } else if (arg === "--base-url") {
      args.baseUrl = argv[++i];
      args.baseUrlSpecified = true;
    } else if (arg.startsWith("--base-url=")) {
      args.baseUrl = arg.slice("--base-url=".length);
      args.baseUrlSpecified = true;
    } else if (arg === "--timeout") {
      args.timeout = Number(argv[++i]);
    } else if (arg.startsWith("--timeout=")) {
      args.timeout = Number(arg.slice("--timeout=".length));
    } else if (arg === "--retries") {
      args.retries = Number(argv[++i]);
    } else if (arg.startsWith("--retries=")) {
      args.retries = Number(arg.slice("--retries=".length));
    } else if (arg === "--session") {
      args.sessionId = argv[++i];
    } else if (arg.startsWith("--session=")) {
      args.sessionId = arg.slice("--session=".length);
    } else if (arg === "--no-tools") {
      args.noTools = true;
    } else if (arg === "--no-agents") {
      args.noAgents = true;
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
  if (!Number.isInteger(args.retries) || args.retries < 0) {
    throw new Error("--retries must be a non-negative integer");
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

function getSessionsDir() {
  return path.join(os.homedir(), ".sakana", "sessions");
}

function createSessionId(cwd) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const cwdHash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${timestamp}-${cwdHash}-${randomUUID().slice(0, 8)}`;
}

function sessionPathForId(sessionId) {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

function readSessionFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listSessionFiles() {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }
  return fs.readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(sessionsDir, name));
}

function findLatestSession(cwd) {
  const sessions = [];
  for (const filePath of listSessionFiles()) {
    try {
      const session = readSessionFile(filePath);
      if (session.cwd === cwd) {
        sessions.push({ ...session, filePath });
      }
    } catch {
      // Ignore malformed session files.
    }
  }
  sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return sessions[0] || null;
}

function saveSession(state) {
  if (!state.sessionId) {
    return;
  }
  const sessionsDir = getSessionsDir();
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const session = {
    version: 1,
    id: state.sessionId,
    cwd: state.cwd,
    createdAt: state.sessionCreatedAt,
    updatedAt: new Date().toISOString(),
    model: state.model,
    baseUrl: state.baseUrl,
    toolsEnabled: state.toolsEnabled,
    agentFiles: state.agentFiles.map((agentFile) => agentFile.path),
    contextFiles: state.contextFiles,
    messages: state.messages,
  };
  const filePath = state.sessionPath || sessionPathForId(state.sessionId);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  state.sessionPath = filePath;
}

function loadSession({ cwd, sessionId }) {
  if (sessionId) {
    const filePath = sessionPathForId(sessionId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return { ...readSessionFile(filePath), filePath };
  }
  const latest = findLatestSession(cwd);
  if (!latest) {
    throw new Error(`No saved session found for ${cwd}`);
  }
  return latest;
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

function formatAgentsInstructions(agentFiles, cwd) {
  if (!agentFiles.length) {
    return "";
  }

  const blocks = agentFiles.map((agentFile) => {
    const display = relativeOrAbsolute(agentFile.path, cwd);
    return `<agents path="${display}">\n${agentFile.content}\n</agents>`;
  });

  return [
    "以下はこのワークスペースのAGENTS.mdから読み込んだ作業指示です。矛盾がある場合は、より下位ディレクトリに近いAGENTS.mdの指示を優先してください。",
    ...blocks,
  ].join("\n\n");
}

function makeSystemPrompt(cwd, agentFiles = []) {
  const base = [
    "あなたはCodex CLIのように、ターミナル上で開発を支援する実用的なAIアシスタントです。",
    "ユーザーはローカルのプロジェクトで作業しています。必要なファイル作成、編集、検証コマンド実行は利用可能なツールで自分で行ってください。",
    "実装を依頼されたら、原則として確認待ちで止まらず、合理的な仮定を置いて作業を完了してください。",
    "ユーザーにコマンド実行やファイル作成を依頼するだけで終わらないでください。あなた自身がツールを呼び出して作業してください。",
    "作業後は、変更内容と検証結果を簡潔に報告してください。",
    `現在の作業ディレクトリ: ${cwd}`,
  ];
  const agents = formatAgentsInstructions(agentFiles, cwd);
  if (agents) {
    base.push(agents);
  }
  return base.join("\n\n");
}

function defaultAgentsContent() {
  return `# AGENTS.md

## Project Instructions

- Work in the current repository unless the user explicitly asks otherwise.
- Prefer small, focused changes that match the existing project style.
- Read relevant files before editing.
- Run available checks after changes when practical.
- Do not expose secrets or API keys.

## Sakana CLI

- Use local tools to inspect, edit, and verify files.
- Summarize changes and verification results at the end of the task.
`;
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

function findAgentsFiles(cwd) {
  const dirs = [];
  let current = cwd;
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dirs
    .reverse()
    .map((dir) => path.join(dir, "AGENTS.md"))
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    .map((candidate) => ({
      path: candidate,
      content: readTextFile(candidate),
    }));
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
  console.log(`│ session: ${color("dim", state.sessionId)}`);
  console.log(`│ model: ${color("cyan", state.model)}`);
  console.log(`│ cwd: ${color("green", state.cwd)}`);
  console.log(`│ credentials: ${color("dim", credentialLabel)}`);
  console.log(`│ tools: ${state.toolsEnabled ? color("green", "enabled") : color("dim", "disabled")}`);
  console.log(`│ timeout/retries: ${state.timeout}s / ${state.retries}`);
  console.log(`│ AGENTS.md: ${state.agentFiles.length ? color("green", `${state.agentFiles.length} loaded`) : color("dim", "none")}`);
  console.log("│");
  console.log(`│ Type ${color("bold", "/help")} for commands, ${color("bold", "/quit")} to exit.`);
  console.log(color("cyan", "╰───────────────────────────────────────────────────╯"));
}

function printHelp() {
  console.log(`Commands
/help            Show this help
/init            Create AGENTS.md in the current workspace
/status          Show current model, cwd, and context files
/model NAME      Switch model: fugu or fugu-ultra
/reset           Clear conversation history
/add PATH        Add a file to persistent context
/context         List persistent context files
/clear-context   Clear persistent context files
/quit            Exit

You can also attach a file once with @path/to/file in your prompt.`);
}

function getSlashSuggestions(buffer) {
  if (!buffer.startsWith("/") || /\s/.test(buffer)) {
    return [];
  }
  return SLASH_COMMANDS
    .filter((command) => command.name.startsWith(buffer))
    .slice(0, 8);
}

function renderPromptLine(buffer, previousSuggestionLines) {
  cursorTo(output, 0);
  clearLine(output, 0);
  for (let i = 0; i < previousSuggestionLines; i += 1) {
    moveCursor(output, 0, 1);
    clearLine(output, 0);
  }
  if (previousSuggestionLines) {
    moveCursor(output, 0, -previousSuggestionLines);
  }

  const suggestions = getSlashSuggestions(buffer);
  cursorTo(output, 0);
  output.write(`› ${buffer}`);
  for (const suggestion of suggestions) {
    output.write(`\n  ${color("cyan", suggestion.name.padEnd(16))} ${color("dim", suggestion.description)}`);
  }
  if (suggestions.length) {
    moveCursor(output, 0, -suggestions.length);
    cursorTo(output, 2 + buffer.length);
  }
  return suggestions.length;
}

function readPromptLine() {
  if (!input.isTTY || !output.isTTY) {
    const rl = readlinePromises.createInterface({ input, output });
    return rl.question("\n› ").finally(() => rl.close());
  }

  return new Promise((resolve) => {
    let buffer = "";
    let suggestionLines = 0;
    const wasRaw = Boolean(input.isRaw);

    output.write("\n");
    input.setRawMode(true);
    input.resume();
    suggestionLines = renderPromptLine(buffer, suggestionLines);

    function finish(value) {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      cursorTo(output, 0);
      clearLine(output, 0);
      for (let i = 0; i < suggestionLines; i += 1) {
        moveCursor(output, 0, 1);
        clearLine(output, 0);
      }
      if (suggestionLines) {
        moveCursor(output, 0, -suggestionLines);
      }
      cursorTo(output, 0);
      output.write(`› ${buffer}\n`);
      resolve(value);
    }

    function redraw() {
      suggestionLines = renderPromptLine(buffer, suggestionLines);
    }

    function handleCharacter(char) {
      if (char === "\u0003") {
        finish(null);
        return false;
      }
      if (char === "\r" || char === "\n") {
        finish(buffer);
        return false;
      }
      if (char === "\u007f" || char === "\b") {
        buffer = buffer.slice(0, -1);
        redraw();
        return true;
      }
      if (char === "\u0015") {
        buffer = "";
        redraw();
        return true;
      }
      if (char === "\t") {
        const suggestions = getSlashSuggestions(buffer);
        if (suggestions.length === 1) {
          buffer = `${suggestions[0].name} `;
          redraw();
        }
        return true;
      }
      if (char >= " " && char !== "\u007f") {
        buffer += char;
        redraw();
      }
      return true;
    }

    function onData(chunk) {
      const value = chunk.toString("utf8");
      if (value.startsWith("\u001b")) {
        return;
      }
      for (const char of value) {
        if (!handleCharacter(char)) {
          break;
        }
      }
    }

    input.on("data", onData);
  });
}

function printStatus(state) {
  const context = state.contextFiles.length
    ? state.contextFiles.map((filePath) => `- ${filePath}`).join("\n")
    : "(none)";
  const agents = state.agentFiles.length
    ? state.agentFiles.map((agentFile) => `- ${agentFile.path}`).join("\n")
    : "(none)";
console.log(`model: ${state.model}
session: ${state.sessionId}
base_url: ${state.baseUrl}
cwd: ${state.cwd}
credentials: ${state.apiKeySource || "(none)"}
tools: ${state.toolsEnabled ? "enabled" : "disabled"}
timeout: ${state.timeout}s
retries: ${state.retries}
AGENTS.md:
${agents}
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
    return `${context} timed out after ${state.timeout}s after ${state.retries + 1} attempt(s). Try continuing, or start sakana with --timeout ${Math.max(state.timeout * 2, DEFAULT_TIMEOUT_SECONDS)} --retries ${Math.max(state.retries, DEFAULT_RETRIES)}.`;
  }
  return error?.message || String(error);
}

function describeRetryableAttempt(error, state, context) {
  if (error?.name === "AbortError") {
    return `${context} timed out after ${state.timeout}s`;
  }
  return error?.message || String(error);
}

function getHttpStatus(error) {
  const match = String(error?.message || "").match(/^HTTP\s+(\d+)/);
  return match ? Number(match[1]) : null;
}

function isRetryableError(error) {
  if (error?.name === "AbortError") {
    return true;
  }
  const status = getHttpStatus(error);
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(state, label, requestFn) {
  const attempts = state.retries + 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), state.timeout * 1000);

    try {
      if (attempt > 1) {
        console.log(color("dim", `${label}: retry ${attempt}/${attempts}`));
      }
      return await requestFn(controller.signal, attempt, attempts);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt === attempts) {
        throw error;
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.error(color("red", `${label}: ${describeRetryableAttempt(error, state, label)}. Retrying in ${delayMs / 1000}s...`));
      await sleep(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
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
  if (command === "/init") {
    const agentsPath = path.join(state.cwd, "AGENTS.md");
    if (fs.existsSync(agentsPath)) {
      console.log(color("dim", `AGENTS.md already exists: ${agentsPath}`));
      return "handled";
    }
    fs.writeFileSync(agentsPath, defaultAgentsContent(), { mode: 0o644 });
    state.agentFiles = findAgentsFiles(state.cwd);
    state.systemPrompt = makeSystemPrompt(state.cwd, state.agentFiles);
    if (state.messages[0]?.role === "system") {
      state.messages[0].content = state.systemPrompt;
    }
    saveSession(state);
    console.log(color("green", `Created ${agentsPath}`));
    return "handled";
  }
  if (command === "/status") {
    printStatus(state);
    return "handled";
  }
  if (command === "/reset") {
    resetMessages(state);
    saveSession(state);
    console.log(color("green", "Conversation history cleared."));
    return "handled";
  }
  if (command === "/model") {
    if (!["fugu", "fugu-ultra"].includes(arg)) {
      console.error(color("red", "Usage: /model fugu|fugu-ultra"));
      return "handled";
    }
    state.model = arg;
    saveSession(state);
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
    saveSession(state);
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
    saveSession(state);
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
  saveSession(state);

  const chunks = [];

  console.log(`\n${color("bold", color("cyan", "sakana"))}`);

  try {
    const response = await requestWithRetry(state, "chat", (signal) => postChatCompletion(state, signal));
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
    saveSession(state);
    throw new Error(describeError(error, state, "Chat request"));
  }

  const answer = chunks.join("");
  state.messages.push({ role: "assistant", content: answer });
  saveSession(state);
  return answer;
}

async function agentResponse(state, userPrompt) {
  const userMessage = buildUserMessage(userPrompt, state);
  state.messages.push({ role: "user", content: userMessage });
  saveSession(state);

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    let completion;

    try {
      completion = await requestWithRetry(state, "agent", (signal, attempt, attempts) => {
        console.log(color("dim", `agent: turn ${turn + 1}/${MAX_AGENT_TURNS} attempt ${attempt}/${attempts} waiting for ${state.model}...`));
        return postAgentCompletion(state, signal);
      });
    } catch (error) {
      throw new Error(describeError(error, state, "Agent request"));
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
    saveSession(state);

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
      saveSession(state);
    }
  }

  throw new Error(`Stopped after ${MAX_AGENT_TURNS} tool turns`);
}

async function repl(state) {
  while (true) {
    const inputLine = await readPromptLine();
    if (inputLine === null) {
      return 0;
    }
    const line = inputLine.trim();
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
}

async function main() {
  let argv = process.argv.slice(2);
  if (argv[0] === "update") {
    return runUpdate(argv.slice(1));
  }
  const resumeMode = argv[0] === "resume";
  if (resumeMode) {
    argv = argv.slice(1);
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
  const agentFiles = args.noAgents ? [] : findAgentsFiles(cwd);
  let loadedSession = null;
  if (resumeMode) {
    try {
      loadedSession = loadSession({ cwd, sessionId: args.sessionId });
    } catch (error) {
      console.error(color("red", error.message));
      return 1;
    }
  }

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

  const sessionId = loadedSession?.id || createSessionId(cwd);
  const state = {
    sessionId,
    sessionPath: loadedSession?.filePath || sessionPathForId(sessionId),
    sessionCreatedAt: loadedSession?.createdAt || new Date().toISOString(),
    apiKey: apiKeyInfo.apiKey,
    apiKeySource: apiKeyInfo.source,
    model: args.modelSpecified ? args.model : (loadedSession?.model || args.model),
    baseUrl: args.baseUrlSpecified ? args.baseUrl : (loadedSession?.baseUrl || args.baseUrl),
    timeout: args.timeout,
    retries: args.retries,
    toolsEnabled: args.noTools ? false : (loadedSession?.toolsEnabled ?? true),
    cwd,
    agentFiles,
    contextFiles: loadedSession?.contextFiles || [],
    systemPrompt: makeSystemPrompt(cwd, agentFiles),
    messages: loadedSession?.messages || [],
  };
  if (state.messages.length) {
    if (state.messages[0]?.role === "system") {
      state.messages[0].content = state.systemPrompt;
    } else {
      state.messages.unshift({ role: "system", content: state.systemPrompt });
    }
    console.log(color("dim", `Resumed session ${state.sessionId} (${state.messages.length} message(s))`));
  } else {
    resetMessages(state);
  }
  saveSession(state);

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
    console.error(color("red", `Error: ${error.message || error}`));
    process.exitCode = 1;
  });
