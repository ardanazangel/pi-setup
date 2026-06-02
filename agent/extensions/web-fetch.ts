/**
 * Web Fetch Extension
 *
 * Añade una herramienta web_fetch que permite al agente obtener el contenido
 * HTML crudo de cualquier URL usando curl.
 *
 * Uso:
 *   pi -e ~/.pi/agent/extensions/web-fetch.ts
 *
 * Requisitos:
 *   - curl instalado en el sistema
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Parámetros del tool ──────────────────────────────────────────────────────

const WebFetchParams = Type.Object({
	url: Type.String({
		description: "URL completa a fetchear (incluyendo https://)",
	}),
	headers: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Headers HTTP adicionales, formato "Nombre: Valor"',
		}),
	),
	follow_redirects: Type.Optional(
		Type.Boolean({
			description: "Seguir redirecciones HTTP (default: true)",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout de la petición en segundos (default: 30)",
		}),
	),
});

interface FetchResult {
	url: string;
	status: number;
	body: string;
	responseHeaders: string;
}

interface FetchDetails {
	url: string;
	status: number;
	bodyLength: number;
	error?: string;
}

// ── Lógica de curl ───────────────────────────────────────────────────────────

function curlFetch(
	url: string,
	options: {
		headers?: string[];
		followRedirects?: boolean;
		timeout?: number;
		signal?: AbortSignal;
	},
): Promise<FetchResult> {
	return new Promise((resolve, reject) => {
		const args: string[] = [
			"--silent",
			"--include", // incluye headers de respuesta
			"--max-time",
			String(options.timeout ?? 30),
			"--user-agent",
			"Mozilla/5.0 (compatible; pi-agent/1.0)",
		];

		if (options.followRedirects !== false) {
			args.push("--location");
		}

		for (const header of options.headers ?? []) {
			args.push("--header", header);
		}

		args.push(url);

		const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];

		child.stdout.on("data", (data: Buffer) => chunks.push(data));
		child.stderr.on("data", (data: Buffer) => errChunks.push(data));

		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			options.signal?.removeEventListener("abort", onAbort);
			reject(err);
		});

		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", onAbort);

			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}

			if (code !== 0) {
				const stderr = Buffer.concat(errChunks).toString().trim();
				reject(new Error(`curl falló (${code}): ${stderr}`));
				return;
			}

			const raw = Buffer.concat(chunks).toString("utf-8");

			// Separar headers de body por \r\n\r\n
			const splitIdx = raw.indexOf("\r\n\r\n");
			if (splitIdx === -1) {
				resolve({ url, status: 0, body: raw, responseHeaders: "" });
				return;
			}

			const responseHeaders = raw.slice(0, splitIdx);
			const body = raw.slice(splitIdx + 4);

			// Extraer código de estado HTTP
			const statusMatch = responseHeaders.match(/^HTTP\/\S+\s+(\d+)/);
			const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

			resolve({ url, status, body, responseHeaders });
		});
	});
}

// ── Extensión ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof WebFetchParams, FetchDetails>({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Obtiene el contenido HTML crudo de una URL usando curl. Útil para leer páginas web, llamar APIs HTTP o inspeccionar cualquier recurso accesible por HTTP/HTTPS.",
		promptSnippet: "web_fetch(url) → HTML/texto crudo de la respuesta HTTP",
		parameters: WebFetchParams,

		async execute(_id, params, signal, _onUpdate, _ctx) {
			try {
				const result = await curlFetch(params.url, {
					headers: params.headers,
					followRedirects: params.follow_redirects,
					timeout: params.timeout,
					signal,
				});

				return {
					content: [
						{
							type: "text",
							text: result.body || "(respuesta vacía)",
						},
					],
					details: {
						url: params.url,
						status: result.status,
						bodyLength: result.body.length,
					},
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { url: params.url, status: 0, bodyLength: 0, error: message },
				};
			}
		},

		renderCall(args, theme) {
			const url = args.url.length > 60 ? `${args.url.slice(0, 57)}...` : args.url;
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", url), 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as FetchDetails | undefined;

			if (d?.error) {
				return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			}

			const status = d?.status ? theme.fg(d.status < 400 ? "success" : "error", String(d.status)) : "";
			const size = d?.bodyLength ? theme.fg("dim", ` · ${(d.bodyLength / 1024).toFixed(1)}KB`) : "";

			return new Text(theme.fg("success", "✓ ") + status + size, 0, 0);
		},
	});

	// Comando manual: /fetch <url>
	pi.registerCommand("fetch", {
		description: "Fetchea una URL y muestra info de la respuesta. Uso: /fetch <url>",
		handler: async (args, ctx) => {
			const url = args.trim();
			if (!url) {
				ctx.ui.notify("Uso: /fetch <url>", "error");
				return;
			}

			ctx.ui.notify(`Fetching ${url}...`, "info");

			try {
				const result = await curlFetch(url, { followRedirects: true });
				ctx.ui.notify(`HTTP ${result.status} · ${(result.body.length / 1024).toFixed(1)}KB`, "info");
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Error: ${message}`, "error");
			}
		},
	});
}
