/**
 * mail.ts — Gmail extension for pi
 * Commands:
 *   /mail           → unread emails, prioritized
 *   /mail digest    → one-paragraph summary of inbox
 *   /mail reply <id> → draft reply for a specific email
 *   /mail auth      → re-run OAuth flow
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync
} from "node:fs";
import { createServer } from "node:http";
import * as net from "node:net";
import { execSync } from "node:child_process";

// ── constants ────────────────────────────────────────────────────────────────

const MAIL_DIR   = join(homedir(), ".pi", "MAIL");
const TOKEN_FILE = join(MAIL_DIR, "token.json");
const AGENT_ENV  = join(homedir(), ".pi", "agent", ".env");
const SCOPES     = "https://www.googleapis.com/auth/gmail.modify";
const REDIRECT   = "http://localhost:3000/callback";
const MAX_EMAILS = 15;

// ── env reader ───────────────────────────────────────────────────────────────

function readEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  if (!existsSync(AGENT_ENV)) return undefined;
  for (const line of readFileSync(AGENT_ENV, "utf8").split(/\r?\n/)) {
    const m = line.match(new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.+)$`));
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
  return undefined;
}

// ── token management ─────────────────────────────────────────────────────────

type Token = {
  access_token: string;
  refresh_token: string;
  expiry: number; // ms timestamp
};

function loadToken(): Token | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Token;
  } catch { return null; }
}

function saveToken(t: Token) {
  mkdirSync(MAIL_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
}

async function refreshToken(t: Token): Promise<Token> {
  const clientId     = readEnv("GMAIL_CLIENT_ID")!;
  const clientSecret = readEnv("GMAIL_CLIENT_SECRET")!;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: t.refresh_token,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json() as any;
  if (!data.access_token) throw new Error("Failed to refresh token");

  const updated: Token = {
    access_token:  data.access_token,
    refresh_token: t.refresh_token,
    expiry:        Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  };
  saveToken(updated);
  return updated;
}

async function getValidToken(): Promise<Token> {
  let t = loadToken();
  if (!t) throw new Error("NOT_AUTHED");
  if (Date.now() > t.expiry) t = await refreshToken(t);
  return t;
}

// ── port check ──────────────────────────────────────────────────────────────

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port);
  });
}

// ── OAuth flow ───────────────────────────────────────────────────────────────

async function runOAuthFlow(): Promise<Token> {
  const clientId     = readEnv("GMAIL_CLIENT_ID");
  const clientSecret = readEnv("GMAIL_CLIENT_SECRET");
  if (!clientId || !clientSecret)
    throw new Error("GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set in ~/.pi/agent/.env");

  const authUrl =
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  // open browser
  try { execSync(`open "${authUrl}"`); } catch { /* ignore */ }

  // local callback server
  if (!(await isPortAvailable(3000)))
    throw new Error("Puerto 3000 ocupado. Cierra la aplicación que lo está usando e intenta de nuevo.");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost:3000");
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>Autorizado. Puedes cerrar esta pestaña.</h2></body></html>");
      server.close();
      if (code) resolve(code);
      else reject(new Error("No code in callback"));
    });
    server.listen(3000);
    setTimeout(() => { server.close(); reject(new Error("OAuth timeout")); }, 120_000);
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT,
      grant_type:    "authorization_code",
    }),
  });
  const data = await res.json() as any;
  if (!data.access_token) throw new Error(`OAuth error: ${JSON.stringify(data)}`);

  const token: Token = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry:        Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  };
  saveToken(token);
  return token;
}

// ── Gmail API helpers ────────────────────────────────────────────────────────

async function gmailGet(path: string, token: Token): Promise<any> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return res.json();
}

function decodeBase64(str: string): string {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractBody(payload: any): string {
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data)
        return decodeBase64(part.body.data);
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

type Email = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
};

async function fetchUnread(token: Token, limit = MAX_EMAILS): Promise<Email[]> {
  const list = await gmailGet(
    `/users/me/messages?q=is:unread&maxResults=${limit}`,
    token
  );
  if (!list.messages?.length) return [];

  const emails = await Promise.all(
    list.messages.map(async (m: { id: string }) => {
      const msg = await gmailGet(`/users/me/messages/${m.id}?format=full`, token);
      const headers = msg.payload?.headers ?? [];
      return {
        id:      m.id,
        from:    getHeader(headers, "From"),
        subject: getHeader(headers, "Subject"),
        date:    getHeader(headers, "Date"),
        snippet: msg.snippet ?? "",
        body:    extractBody(msg.payload ?? {}).slice(0, 2000),
      } as Email;
    })
  );
  return emails;
}

// ── formatters ───────────────────────────────────────────────────────────────

function formatEmailsForModel(emails: Email[]): string {
  return emails.map((e, i) =>
    `[${i + 1}] ID: ${e.id}\nDe: ${e.from}\nAsunto: ${e.subject}\nFecha: ${e.date}\nResumen: ${e.snippet}\n---`
  ).join("\n\n");
}

function formatEmailFullForModel(email: Email): string {
  return `ID: ${email.id}\nDe: ${email.from}\nAsunto: ${email.subject}\nFecha: ${email.date}\n\nCuerpo:\n${email.body}`;
}

// ── extension ────────────────────────────────────────────────────────────────

export default function register(api: ExtensionAPI) {
  api.registerCommand("mail", {
    description: "Gmail: lee, resume y redacta respuestas desde pi",
    handler: async (rawArgs: string, _ctx: any) => {
      const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
      const sub = args[0]?.toLowerCase();

      // ── auth ──────────────────────────────────────────────────────────────
      if (sub === "auth") {
        api.sendMessage({
          display: true,
          content: "Iniciando flujo OAuth con Google. Abre el navegador y autoriza el acceso...",
        });
        try {
          await runOAuthFlow();
          api.sendMessage({
            display: true,
            content: "Autenticación completada. Token guardado en ~/.pi/MAIL/token.json",
          });
        } catch (e: any) {
          api.sendMessage({ display: true, content: `Error en autenticación: ${e.message}` });
        }
        return;
      }

      // ── get token (may need auth) ─────────────────────────────────────────
      let token: Token;
      try {
        token = await getValidToken();
      } catch (e: any) {
        if (e.message === "NOT_AUTHED") {
          api.sendMessage({
            display: true,
            content: "No hay token de Gmail. Iniciando autenticación OAuth... (el navegador se abrirá)",
          });
          try {
            token = await runOAuthFlow();
          } catch (e2: any) {
            api.sendMessage({ display: true, content: `Error en autenticación: ${e2.message}` });
            return;
          }
        } else {
          api.sendMessage({ display: true, content: `Error obteniendo token: ${e.message}` });
          return;
        }
      }

      // ── digest ────────────────────────────────────────────────────────────
      if (sub === "digest") {
        const emails = await fetchUnread(token, MAX_EMAILS);
        if (!emails.length) {
          api.sendMessage({ display: true, content: "No hay emails sin leer." });
          return;
        }
        api.sendMessage({
          display: true,
          content: `Tienes ${emails.length} emails sin leer. Haz un resumen ejecutivo en un párrafo corto: qué hay urgente, qué puede esperar, qué se puede ignorar.\n\n${formatEmailsForModel(emails)}`,
        });
        return;
      }

      // ── reply ─────────────────────────────────────────────────────────────
      if (sub === "reply") {
        const emailId = args[1];
        if (!emailId) {
          api.sendMessage({ display: true, content: "Uso: /mail reply <id>" });
          return;
        }
        const msg = await gmailGet(`/users/me/messages/${emailId}?format=full`, token);
        const headers = msg.payload?.headers ?? [];
        const email: Email = {
          id:      emailId,
          from:    getHeader(headers, "From"),
          subject: getHeader(headers, "Subject"),
          date:    getHeader(headers, "Date"),
          snippet: msg.snippet ?? "",
          body:    extractBody(msg.payload ?? {}).slice(0, 3000),
        };
        api.sendMessage({
          display: true,
          content: `Redacta una respuesta concisa y natural para este email. No uses lenguaje corporativo ni frases de relleno. Muestra el draft claramente delimitado.\n\n${formatEmailFullForModel(email)}`,
        });
        return;
      }

      // ── default: unread list ──────────────────────────────────────────────
      const emails = await fetchUnread(token, MAX_EMAILS);
      if (!emails.length) {
        api.sendMessage({ display: true, content: "Inbox limpio. No hay emails sin leer." });
        return;
      }
      api.sendMessage({
        display: true,
        content: `Tengo ${emails.length} emails sin leer. Analízalos, marca cuáles son urgentes (🔴), cuáles requieren respuesta (🟡) y cuáles se pueden ignorar/archivar (⚫). Para cada uno muestra: número, remitente, asunto y una línea de qué trata. Al final dame una recomendación de qué hacer primero.\n\n${formatEmailsForModel(emails)}`,
      });
    },
  });
}
