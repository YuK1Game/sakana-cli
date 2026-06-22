from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from dotenv import find_dotenv, load_dotenv
from openai import OpenAI
from rich.console import Console
from rich.panel import Panel
from rich.status import Status

from sakana_cli import __version__


MAX_FILE_BYTES = 40_000
ATTACHMENT_RE = re.compile(r"(?<!\S)@([^\s]+)")


@dataclass
class SessionState:
    model: str
    cwd: Path
    system_prompt: str
    base_url: str
    timeout: float
    context_files: list[Path] = field(default_factory=list)
    messages: list[dict[str, str]] = field(default_factory=list)

    def reset_messages(self) -> None:
        self.messages = [{"role": "system", "content": self.system_prompt}]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sakana",
        description="Codex-like interactive CLI for Sakana Fugu.",
    )
    parser.add_argument("prompt", nargs="*", help="Run a single prompt and exit.")
    parser.add_argument("--model", default=os.getenv("SAKANA_MODEL", "fugu"), choices=["fugu", "fugu-ultra"])
    parser.add_argument("--base-url", default=os.getenv("SAKANA_BASE_URL", "https://api.sakana.ai/v1"))
    parser.add_argument("--timeout", type=float, default=float(os.getenv("SAKANA_TIMEOUT", "120")))
    parser.add_argument("--version", action="version", version=f"sakana-cli {__version__}")
    return parser


def find_env_file(cwd: Path) -> str:
    explicit = os.getenv("SAKANA_ENV_FILE")
    if explicit:
        return explicit
    return find_dotenv(filename=".env", usecwd=True)


def make_system_prompt(cwd: Path) -> str:
    return (
        "あなたはCodex CLIのように、ターミナル上で開発を支援する実用的なAIアシスタントです。\n"
        "ユーザーはローカルのプロジェクトで作業しています。回答は簡潔に、実装・設計・デバッグに直接使える形にしてください。\n"
        "ファイル編集やコマンド実行が必要な場合は、具体的なコマンド、パッチ方針、注意点を示してください。\n"
        "不明点があれば、作業を止める前に合理的な仮定を置いて進める案を提示してください。\n"
        f"現在の作業ディレクトリ: {cwd}"
    )


def resolve_path(raw_path: str, cwd: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return path.resolve()


def read_text_file(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(path)
    if not path.is_file():
        raise IsADirectoryError(path)

    data = path.read_bytes()
    truncated = len(data) > MAX_FILE_BYTES
    data = data[:MAX_FILE_BYTES]
    text = data.decode("utf-8", errors="replace")
    if truncated:
        text += f"\n\n[truncated after {MAX_FILE_BYTES} bytes]"
    return text


def format_file_context(paths: Iterable[Path], cwd: Path) -> str:
    blocks: list[str] = []
    for path in paths:
        text = read_text_file(path)
        try:
            display = path.relative_to(cwd)
        except ValueError:
            display = path
        blocks.append(f'<file path="{display}">\n{text}\n</file>')
    return "\n\n".join(blocks)


def collect_inline_attachments(prompt: str, cwd: Path, console: Console) -> tuple[str, list[Path]]:
    paths: list[Path] = []
    for match in ATTACHMENT_RE.finditer(prompt):
        raw = match.group(1)
        try:
            path = resolve_path(raw, cwd)
            if path.is_file():
                paths.append(path)
        except OSError as exc:
            console.print(f"[red]Could not attach @{raw}: {exc}[/red]")
    return prompt, paths


def build_user_message(prompt: str, state: SessionState, console: Console) -> str:
    _, inline_paths = collect_inline_attachments(prompt, state.cwd, console)
    all_paths = [*state.context_files, *inline_paths]
    if not all_paths:
        return prompt

    try:
        context = format_file_context(all_paths, state.cwd)
    except OSError as exc:
        console.print(f"[red]Could not read context file: {exc}[/red]")
        return prompt

    return f"{prompt}\n\n<context>\n{context}\n</context>"


def create_client(base_url: str) -> OpenAI:
    api_key = os.getenv("SAKANA_API_KEY")
    if not api_key:
        raise RuntimeError("SAKANA_API_KEY is not set. Put it in .env or export it in your shell.")
    return OpenAI(api_key=api_key, base_url=base_url)


def print_banner(console: Console, state: SessionState, env_file: str) -> None:
    env_label = env_file if env_file else "not found"
    console.print(
        Panel.fit(
            f"[bold]Sakana CLI[/bold] [dim]v{__version__}[/dim]\n"
            f"model: [cyan]{state.model}[/cyan]\n"
            f"cwd: [green]{state.cwd}[/green]\n"
            f".env: [dim]{env_label}[/dim]\n\n"
            "Type [bold]/help[/bold] for commands, [bold]/quit[/bold] to exit.",
            border_style="cyan",
        )
    )


def print_help(console: Console) -> None:
    console.print(
        """[bold]Commands[/bold]
/help            Show this help
/status          Show current model, cwd, and context files
/model NAME      Switch model: fugu or fugu-ultra
/reset           Clear conversation history
/add PATH        Add a file to persistent context
/context         List persistent context files
/clear-context   Clear persistent context files
/quit            Exit

You can also attach a file once with @path/to/file in your prompt."""
    )


def print_status(console: Console, state: SessionState) -> None:
    context = "\n".join(f"- {p}" for p in state.context_files) or "(none)"
    console.print(
        Panel(
            f"model: [cyan]{state.model}[/cyan]\n"
            f"base_url: [cyan]{state.base_url}[/cyan]\n"
            f"cwd: [green]{state.cwd}[/green]\n"
            f"messages: {len(state.messages)}\n"
            f"context files:\n{context}",
            title="Status",
            border_style="blue",
        )
    )


def handle_command(line: str, state: SessionState, console: Console) -> bool:
    parts = line.split(maxsplit=1)
    command = parts[0]
    arg = parts[1].strip() if len(parts) > 1 else ""

    if command in {"/quit", "/exit"}:
        raise EOFError
    if command == "/help":
        print_help(console)
        return True
    if command == "/status":
        print_status(console, state)
        return True
    if command == "/reset":
        state.reset_messages()
        console.print("[green]Conversation history cleared.[/green]")
        return True
    if command == "/model":
        if arg not in {"fugu", "fugu-ultra"}:
            console.print("[red]Usage: /model fugu|fugu-ultra[/red]")
            return True
        state.model = arg
        console.print(f"[green]Model switched to {arg}.[/green]")
        return True
    if command == "/add":
        if not arg:
            console.print("[red]Usage: /add PATH[/red]")
            return True
        path = resolve_path(arg, state.cwd)
        try:
            read_text_file(path)
        except OSError as exc:
            console.print(f"[red]Could not add file: {exc}[/red]")
            return True
        if path not in state.context_files:
            state.context_files.append(path)
        console.print(f"[green]Added context:[/green] {path}")
        return True
    if command == "/context":
        if not state.context_files:
            console.print("[dim]No persistent context files.[/dim]")
        else:
            for path in state.context_files:
                console.print(f"- {path}")
        return True
    if command == "/clear-context":
        state.context_files.clear()
        console.print("[green]Context cleared.[/green]")
        return True

    console.print(f"[red]Unknown command:[/red] {command}")
    return True


def stream_response(client: OpenAI, state: SessionState, user_prompt: str, console: Console) -> str:
    user_message = build_user_message(user_prompt, state, console)
    state.messages.append({"role": "user", "content": user_message})

    chunks: list[str] = []
    console.print("\n[bold cyan]sakana[/bold cyan]")
    try:
        stream = client.chat.completions.create(
            model=state.model,
            messages=state.messages,
            stream=True,
            timeout=state.timeout,
        )
        for event in stream:
            delta = event.choices[0].delta.content or ""
            if delta:
                chunks.append(delta)
                console.print(delta, end="")
        console.print()
    except Exception:
        state.messages.pop()
        raise

    answer = "".join(chunks)
    state.messages.append({"role": "assistant", "content": answer})
    return answer


def run_once(client: OpenAI, state: SessionState, prompt: str, console: Console) -> int:
    with Status("Thinking...", console=console, spinner="dots"):
        stream_response(client, state, prompt, console)
    return 0


def repl(client: OpenAI, state: SessionState, console: Console) -> int:
    while True:
        try:
            line = input("\n› ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print()
            return 0

        if not line:
            continue
        if line.startswith("/"):
            try:
                handle_command(line, state, console)
            except EOFError:
                return 0
            continue

        try:
            stream_response(client, state, line, console)
        except Exception as exc:
            console.print(f"[red]Error:[/red] {exc}")


def main() -> int:
    args = build_parser().parse_args()
    cwd = Path.cwd().resolve()
    env_file = find_env_file(cwd)
    if env_file:
        load_dotenv(env_file)

    state = SessionState(
        model=args.model,
        cwd=cwd,
        system_prompt=make_system_prompt(cwd),
        base_url=args.base_url,
        timeout=args.timeout,
    )
    state.reset_messages()

    console = Console()
    try:
        client = create_client(args.base_url)
    except RuntimeError as exc:
        console.print(f"[red]{exc}[/red]")
        return 1

    prompt = " ".join(args.prompt).strip()
    if prompt:
        return run_once(client, state, prompt, console)

    print_banner(console, state, env_file)
    return repl(client, state, console)


if __name__ == "__main__":
    raise SystemExit(main())
