/**
 * YouTube Transcript Extension
 *
 * Añade una herramienta youtube_transcript que extrae la transcripción
 * de cualquier video de YouTube usando youtube-transcript-api (Python).
 *
 * Uso:
 *   pi -e ~/.pi/agent/extensions/youtube-transcript.ts
 *
 * Requisitos:
 *   - python3 instalado
 *   - pip3 install youtube-transcript-api
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Parámetros del tool ──────────────────────────────────────────────────────

const YoutubeTranscriptParams = Type.Object({
	url: Type.String({
		description: "URL de YouTube (https://youtube.com/watch?v=...) o video ID directamente",
	}),
	language: Type.Optional(
		Type.String({
			description: 'Código de idioma preferido, ej: "es", "en", "fr". Por defecto inglés o el disponible.',
		}),
	),
	timestamps: Type.Optional(
		Type.Boolean({
			description: "Incluir timestamps [MM:SS] en la transcripción (default: false)",
		}),
	),
	list_languages: Type.Optional(
		Type.Boolean({
			description: "Solo listar los idiomas disponibles sin devolver transcripción (default: false)",
		}),
	),
});

interface TranscriptDetails {
	videoId: string;
	language?: string;
	snippets?: number;
	error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractVideoId(input: string): string {
	// Ya es un ID (11 chars alfanuméricos)
	if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

	// youtube.com/watch?v=ID
	const watchMatch = input.match(/[?&]v=([A-Za-z0-9_-]{11})/);
	if (watchMatch) return watchMatch[1];

	// youtu.be/ID
	const shortMatch = input.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
	if (shortMatch) return shortMatch[1];

	// youtube.com/embed/ID
	const embedMatch = input.match(/embed\/([A-Za-z0-9_-]{11})/);
	if (embedMatch) return embedMatch[1];

	throw new Error(`No se pudo extraer el video ID de: ${input}`);
}

function formatSeconds(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function runPython(script: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];

		child.stdout.on("data", (data: Buffer) => chunks.push(data));
		child.stderr.on("data", (data: Buffer) => errChunks.push(data));

		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});

		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);

			if (signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}

			if (code !== 0) {
				const stderr = Buffer.concat(errChunks).toString().trim();
				reject(new Error(stderr || `python3 salió con código ${code}`));
				return;
			}

			resolve(Buffer.concat(chunks).toString("utf-8"));
		});
	});
}

async function listLanguages(videoId: string, signal?: AbortSignal): Promise<string> {
	const script = `
import json
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
transcripts = api.list(${JSON.stringify(videoId)})
result = []
for t in transcripts:
    result.append({"code": t.language_code, "language": t.language, "generated": t.is_generated})
print(json.dumps(result))
`;
	const output = await runPython(script, signal);
	const langs: { code: string; language: string; generated: boolean }[] = JSON.parse(output);
	const lines = langs.map(
		(l) => `  ${l.code.padEnd(8)} ${l.language}${l.generated ? " (auto-generado)" : ""}`,
	);
	return `Idiomas disponibles para ${videoId}:\n${lines.join("\n")}`;
}

async function fetchTranscript(
	videoId: string,
	options: { language?: string; timestamps?: boolean; signal?: AbortSignal },
): Promise<{ text: string; language: string; snippets: number }> {
	const langArg = options.language ? JSON.stringify([options.language]) : "None";

	const script = `
import json
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
try:
    transcript_list = api.list(${JSON.stringify(videoId)})
    if ${langArg} is not None:
        transcript = transcript_list.find_transcript(${langArg})
    else:
        transcript = transcript_list.find_transcript(['en'])
except Exception:
    try:
        transcript = next(iter(api.list(${JSON.stringify(videoId)})))
    except Exception as e:
        raise e

fetched = transcript.fetch()
snippets = list(fetched)
result = {
    "language": transcript.language_code,
    "snippets": [{"text": s.text, "start": s.start} for s in snippets]
}
print(json.dumps(result))
`;

	const output = await runPython(script, options.signal);
	const data: { language: string; snippets: { text: string; start: number }[] } = JSON.parse(output);

	let text: string;
	if (options.timestamps) {
		text = data.snippets
			.map((s) => `[${formatSeconds(s.start)}] ${s.text}`)
			.join("\n");
	} else {
		text = data.snippets.map((s) => s.text).join(" ");
	}

	return { text, language: data.language, snippets: data.snippets.length };
}

// ── Extensión ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof YoutubeTranscriptParams, TranscriptDetails>({
		name: "youtube_transcript",
		label: "YouTube Transcript",
		description:
			"Extrae la transcripción de un video de YouTube. Acepta URL completa o video ID. Permite elegir idioma y formato con o sin timestamps.",
		promptSnippet:
			"youtube_transcript(url, language?, timestamps?, list_languages?) → texto completo de la transcripción",
		parameters: YoutubeTranscriptParams,

		async execute(_id, params, signal, _onUpdate, _ctx) {
			let videoId: string;

			try {
				videoId = extractVideoId(params.url);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { videoId: params.url, error: message },
				};
			}

			try {
				if (params.list_languages) {
					const text = await listLanguages(videoId, signal);
					return {
						content: [{ type: "text", text }],
						details: { videoId },
					};
				}

				const result = await fetchTranscript(videoId, {
					language: params.language,
					timestamps: params.timestamps,
					signal,
				});

				return {
					content: [{ type: "text", text: result.text }],
					details: {
						videoId,
						language: result.language,
						snippets: result.snippets,
					},
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { videoId, error: message },
				};
			}
		},

		renderCall(args, theme) {
			let videoId = args.url;
			try {
				videoId = extractVideoId(args.url);
			} catch {}
			const lang = args.language ? ` [${args.language}]` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("youtube_transcript ")) + theme.fg("accent", videoId) + theme.fg("dim", lang),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const d = result.details as TranscriptDetails | undefined;

			if (d?.error) {
				return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			}

			const lang = d?.language ? theme.fg("accent", d.language) : "";
			const count = d?.snippets ? theme.fg("dim", ` · ${d.snippets} fragmentos`) : "";

			return new Text(theme.fg("success", "✓ ") + lang + count, 0, 0);
		},
	});

	// Comando manual: /transcript <url> [lang]
	pi.registerCommand("transcript", {
		description: "Extrae transcripción de un video de YouTube. Uso: /transcript <url> [idioma]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const url = parts[0];
			const language = parts[1];

			if (!url) {
				ctx.ui.notify("Uso: /transcript <url> [idioma]", "error");
				return;
			}

			let videoId: string;
			try {
				videoId = extractVideoId(url);
			} catch (err: unknown) {
				ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			ctx.ui.notify(`Obteniendo transcripción de ${videoId}...`, "info");

			try {
				const result = await fetchTranscript(videoId, { language });
				ctx.ui.notify(
					`✓ ${result.language} · ${result.snippets} fragmentos · ${result.text.length} chars`,
					"info",
				);
			} catch (err: unknown) {
				ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
