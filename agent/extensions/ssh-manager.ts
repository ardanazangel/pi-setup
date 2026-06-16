/**
 * ssh-manager — adds SSH servers without the agent (LLM) seeing the password.
 *
 * Commands:
 *   /ssh-add   Asks for alias, user@host, port, and password (masked input).
 *              Installs your public key on the server with ssh-copy-id (key-based
 *              auth from then on) and writes the Host block to ~/.ssh/config.
 *              The password is passed through the SSHPASS environment variable (does not appear in
 *              `ps`, is not saved to disk, does not enter the model context).
 *   /ssh-list  Lists the servers defined in ~/.ssh/config.
 *
 * Requirements:
 *   - sshpass installed (macOS: `brew install hudochenkov/sshpass/sshpass`)
 *   - An SSH key (if you do not have one: `ssh-keygen -t ed25519`)
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const SSH_DIR = join(homedir(), ".ssh");
const CONFIG_PATH = join(SSH_DIR, "config");

function run(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      },
    );
  });
}

function findPublicKey(): string | null {
  for (const name of ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]) {
    const p = join(SSH_DIR, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function parseHosts(): { alias: string; hostName?: string; user?: string; port?: string }[] {
  if (!existsSync(CONFIG_PATH)) return [];
  const lines = readFileSync(CONFIG_PATH, "utf8").split("\n");
  const hosts: { alias: string; hostName?: string; user?: string; port?: string }[] = [];
  let current: (typeof hosts)[number] | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^host\s+/i.test(line)) {
      const alias = line.split(/\s+/).slice(1).join(" ");
      if (alias === "*") {
        current = null;
        continue;
      }
      current = { alias };
      hosts.push(current);
    } else if (current) {
      const m = line.match(/^(\w+)\s+(.+)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === "hostname") current.hostName = m[2];
      else if (key === "user") current.user = m[2];
      else if (key === "port") current.port = m[2];
    }
  }
  return hosts;
}

function ensureSshDir() {
  if (!existsSync(SSH_DIR)) {
    mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  }
}

function aliasExists(alias: string): boolean {
  return parseHosts().some((h) => h.alias === alias);
}

function appendHostBlock(alias: string, host: string, user: string, port: string) {
  ensureSshDir();
  const block =
    `\nHost ${alias}\n` +
    `  HostName ${host}\n` +
    `  User ${user}\n` +
    (port && port !== "22" ? `  Port ${port}\n` : "");
  appendFileSync(CONFIG_PATH, block, "utf8");
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore */
  }
}

// Masked input: shows • per character, returns the string or null on Escape.
function maskedInput(ctx: any, label: string): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
    let value = "";
    const render = (_width: number): string[] => [
      theme.fg("accent", label + " ") + theme.fg("dim", "•".repeat(value.length) + "▌"),
    ];
    const handleInput = (data: string) => {
      if (matchesKey(data, Key.enter)) {
        done(value);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        value = value.slice(0, -1);
        tui.requestRender();
        return;
      }
      // Printable characters: 1 key or pasted multiple characters. Filters controls.
      const printable = data.replace(/[\u0000-\u001f\u007f]/g, "");
      if (printable) {
        value += printable;
        tui.requestRender();
      }
    };
    return { render, handleInput };
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ssh-add", {
    description: "Add an SSH server (installs your key without the agent seeing the password)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("ssh-add needs interactive mode", "error");
        return;
      }

      const pubKey = findPublicKey();
      if (!pubKey) {
        ctx.ui.notify("No public key found in ~/.ssh. Generate one: ssh-keygen -t ed25519", "error");
        return;
      }

      // sshpass available?
      const which = await run("which", ["sshpass"]);
      if (which.code !== 0) {
        ctx.ui.notify(
          "sshpass is missing. Install: brew install hudochenkov/sshpass/sshpass",
          "error",
        );
        return;
      }

      const target = await ctx.ui.input("Server (user@host):", "user@192.168.1.50");
      if (!target || !target.includes("@")) {
        ctx.ui.notify("Invalid format, use user@host", "error");
        return;
      }
      const [user, host] = target.split("@");

      const port = (await ctx.ui.input("Port:", "22")) || "22";

      const aliasInput = await ctx.ui.input("Alias (Enter = use the host):", host);
      const alias = aliasInput && aliasInput.trim() ? aliasInput.trim() : host;

      if (aliasExists(alias)) {
        const ok = await ctx.ui.confirm("Alias exists", `"${alias}" is already in config. Continue anyway?`);
        if (!ok) return;
      }

      const password = await maskedInput(ctx, "SSH password:");
      if (password === null) {
        ctx.ui.notify("Canceled", "info");
        return;
      }

      ctx.ui.setStatus("ssh-add", "Installing key...");
      const res = await run(
        "sshpass",
        [
          "-e",
          "ssh-copy-id",
          "-i",
          pubKey,
          "-p",
          port,
          "-o",
          "StrictHostKeyChecking=accept-new",
          `${user}@${host}`,
        ],
        { SSHPASS: password },
      );
      ctx.ui.setStatus("ssh-add", undefined);

      if (res.code !== 0) {
        ctx.ui.notify(`Error installing the key: ${res.stderr.trim().split("\n").pop()}`, "error");
        return;
      }

      appendHostBlock(alias, host, user, port);
      ctx.ui.notify(`Done. Connect with: ssh ${alias}  (now without password)`, "info");
    },
  });

  pi.registerCommand("ssh-list", {
    description: "List the SSH servers in ~/.ssh/config",
    handler: async (_args, ctx) => {
      const hosts = parseHosts();
      if (hosts.length === 0) {
        ctx.ui.notify("No servers in ~/.ssh/config", "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(hosts.map((h) => h.alias).join(", "), "info");
        return;
      }
      const options = hosts.map(
        (h) =>
          `${h.alias}  →  ${h.user ? h.user + "@" : ""}${h.hostName ?? "?"}${h.port ? ":" + h.port : ""}`,
      );
      const choice = await ctx.ui.select("SSH servers (Enter to copy command):", options);
      if (choice) {
        const idx = options.indexOf(choice);
        const h = hosts[idx];
        ctx.ui.setEditorText(`ssh ${h.alias}`);
        ctx.ui.notify(`Command placed in the editor: ssh ${h.alias}`, "info");
      }
    },
  });
}
