/**
 * Gemini Web — acceso a Gemini usando cookies de Chrome.
 * Sin API key, sin dependencias externas.
 * Requiere estar logado en gemini.google.com en Chrome/Arc/Helium.
 *
 * Uso:
 *   import { geminiQuery, isGeminiAvailable } from "./gemini-web.ts";
 *   const result = await geminiQuery("¿Qué es Bun?");
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CookieMap, getGoogleCookies } from "./chrome-cookies.ts";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_URL =
	"https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_UPLOAD_URL = "https://content-push.googleapis.com/upload";
const GEMINI_UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";
const GOOGLE_LIST_ACCOUNTS_URL =
	"https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&laf=b64bin&json=standard";

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MODEL_HEADER_NAME = "x-goog-ext-525001261-jspb";
const MODEL_HEADERS: Record<string, string> = {
	"gemini-3-pro": '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4]]',
	"gemini-2.5-pro": '[1,null,null,null,"4af6c7f5da75d65d",null,null,0,[4]]',
	"gemini-2.5-flash": '[1,null,null,null,"9ec249fc9ad08861",null,null,0,[4]]',
};

const REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

export type GeminiModel = "gemini-3-pro" | "gemini-2.5-pro" | "gemini-2.5-flash";

export interface GeminiOptions {
	model?: GeminiModel;
	files?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Comprueba si Gemini Web está disponible (cookies de Chrome accesibles). */
export async function isGeminiAvailable(): Promise<boolean> {
	if (!isCookieAccessAllowed()) return false;
	const result = await getGoogleCookies({ requiredCookies: REQUIRED_COOKIES });
	return result !== null;
}

/** Ejecuta un prompt en Gemini Web. Lanza error si no hay cookies. */
export async function geminiQuery(prompt: string, options: GeminiOptions = {}): Promise<string> {
	if (!isCookieAccessAllowed()) {
		throw new Error(
			"Browser cookie access not allowed. Add `allowBrowserCookies: true` to ~/.pi/web-search.json or set PI_ALLOW_BROWSER_COOKIES=1.",
		);
	}

	const result = await getGoogleCookies({ requiredCookies: REQUIRED_COOKIES });
	if (!result) {
		throw new Error(
			"Could not read Google cookies from Chrome. Make sure you're signed into gemini.google.com.",
		);
	}

	return queryWithCookies(prompt, result.cookies, options);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function isCookieAccessAllowed(): boolean {
	if (
		process.env.PI_ALLOW_BROWSER_COOKIES === "1" ||
		process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1"
	) {
		return true;
	}
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const config = JSON.parse(raw) as { allowBrowserCookies?: unknown };
		return config.allowBrowserCookies === true;
	} catch {
		return false;
	}
}

async function queryWithCookies(
	prompt: string,
	cookieMap: CookieMap,
	options: GeminiOptions = {},
): Promise<string> {
	const model = options.model && MODEL_HEADERS[options.model] ? options.model : "gemini-2.5-flash";
	const timeoutMs = options.timeoutMs ?? 120000;

	const result = await runOnce(prompt, cookieMap, model, options.files, timeoutMs, options.signal);

	if (result.errorCode === 1052 && model !== "gemini-2.5-flash") {
		const fallback = await runOnce(prompt, cookieMap, "gemini-2.5-flash", options.files, timeoutMs, options.signal);
		if (fallback.errorMessage) throw new Error(fallback.errorMessage);
		if (!fallback.text) throw new Error("Gemini Web returned empty response (fallback)");
		return fallback.text;
	}

	if (result.errorMessage) throw new Error(result.errorMessage);
	if (!result.text) throw new Error("Gemini Web returned empty response");
	return result.text;
}

async function runOnce(
	prompt: string,
	cookieMap: CookieMap,
	model: string,
	files: string[] | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ text: string; errorCode?: number; errorMessage?: string }> {
	const effectiveSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);

	const cookieHeader = buildCookieHeader(cookieMap);
	const accessToken = await fetchAccessToken(cookieHeader, effectiveSignal);

	const uploaded: Array<{ id: string; name: string }> = [];
	if (files) {
		for (const filePath of files) {
			uploaded.push(await uploadFile(filePath, cookieHeader, effectiveSignal));
		}
	}

	const fReq = buildFReqPayload(prompt, uploaded);
	const params = new URLSearchParams();
	params.set("at", accessToken);
	params.set("f.req", fReq);

	const res = await fetch(GEMINI_STREAM_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded;charset=utf-8",
			host: "gemini.google.com",
			origin: "https://gemini.google.com",
			referer: "https://gemini.google.com/",
			"x-same-domain": "1",
			"user-agent": USER_AGENT,
			cookie: cookieHeader,
			[MODEL_HEADER_NAME]: MODEL_HEADERS[model],
		},
		body: params.toString(),
		signal: effectiveSignal,
	});

	const rawText = await res.text();
	if (!res.ok) return { text: "", errorMessage: `Gemini request failed: ${res.status}` };

	try {
		return parseStreamResponse(rawText);
	} catch (err) {
		let errorCode: number | undefined;
		try {
			const json = JSON.parse(trimJsonEnvelope(rawText));
			errorCode = extractErrorCode(json);
		} catch {}
		return {
			text: "",
			errorCode,
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}
}

async function fetchAccessToken(cookieHeader: string, signal: AbortSignal): Promise<string> {
	const html = await fetchFollowingRedirects(GEMINI_APP_URL, cookieHeader, signal);
	for (const key of ["SNlM0e", "thykhd"]) {
		const match = html.match(new RegExp(`"${key}":"(.*?)"`));
		if (match?.[1]) return match[1];
	}
	throw new Error(
		"Unable to authenticate with Gemini. Make sure you're signed into gemini.google.com in Chrome.",
	);
}

async function fetchFollowingRedirects(
	url: string,
	cookieHeader: string,
	signal: AbortSignal,
	maxRedirects = 10,
): Promise<string> {
	let current = url;
	for (let i = 0; i <= maxRedirects; i++) {
		const res = await fetch(current, {
			headers: { "user-agent": USER_AGENT, cookie: cookieHeader },
			redirect: "manual",
			signal,
		});
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (location) { current = new URL(location, current).toString(); continue; }
		}
		return await res.text();
	}
	throw new Error(`Too many redirects (>${maxRedirects})`);
}

async function uploadFile(
	filePath: string,
	cookieHeader: string,
	signal: AbortSignal,
): Promise<{ id: string; name: string }> {
	const data = readFileSync(filePath);
	const fileName = basename(filePath);
	const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
	const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
	const footer = `\r\n--${boundary}--\r\n`;
	const body = Buffer.concat([Buffer.from(header, "utf-8"), data, Buffer.from(footer, "utf-8")]);

	const res = await fetch(GEMINI_UPLOAD_URL, {
		method: "POST",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			"push-id": GEMINI_UPLOAD_PUSH_ID,
			"user-agent": USER_AGENT,
			cookie: cookieHeader,
		},
		body,
		signal,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`File upload failed: ${res.status} (${text.slice(0, 200)})`);
	}

	return { id: await res.text(), name: fileName };
}

function buildFReqPayload(prompt: string, uploaded: Array<{ id: string; name: string }>): string {
	const promptPayload =
		uploaded.length > 0
			? [prompt, 0, null, uploaded.map((f) => [[f.id, 1]])]
			: [prompt];
	return JSON.stringify([null, JSON.stringify([promptPayload, null, null])]);
}

function buildCookieHeader(cookieMap: CookieMap): string {
	return Object.entries(cookieMap)
		.filter(([, value]) => typeof value === "string" && value.length > 0)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function trimJsonEnvelope(text: string): string {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) throw new Error("No JSON payload in response");
	return text.slice(start, end + 1);
}

function getNestedValue(value: unknown, pathParts: number[]): unknown {
	let current: unknown = value;
	for (const part of pathParts) {
		if (!Array.isArray(current)) return undefined;
		current = (current as unknown[])[part];
	}
	return current;
}

function extractErrorCode(responseJson: unknown): number | undefined {
	const code = getNestedValue(responseJson, [0, 5, 2, 0, 1, 0]);
	return typeof code === "number" && code >= 0 ? code : undefined;
}

function parseStreamResponse(rawText: string): { text: string; errorCode?: number } {
	const responseJson = JSON.parse(trimJsonEnvelope(rawText));
	const errorCode = extractErrorCode(responseJson);

	const parts = Array.isArray(responseJson) ? responseJson : [];
	let body: unknown = null;

	for (const part of parts) {
		const partBody = getNestedValue(part, [2]);
		if (!partBody || typeof partBody !== "string") continue;
		try {
			const parsed = JSON.parse(partBody);
			const candidateList = getNestedValue(parsed, [4]);
			if (Array.isArray(candidateList) && candidateList.length > 0) {
				body = parsed;
				break;
			}
		} catch {}
	}

	const candidateList = getNestedValue(body, [4]);
	const firstCandidate = Array.isArray(candidateList) ? (candidateList as unknown[])[0] : undefined;
	let text = (getNestedValue(firstCandidate, [1, 0]) as string | undefined) ?? "";

	if (/^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(text)) {
		const alt = getNestedValue(firstCandidate, [22, 0]) as string | undefined;
		if (alt) text = alt;
	}

	return { text, errorCode };
}
