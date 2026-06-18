import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_BETA_HEADER = "responses=experimental";
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

type OutputFormat = (typeof OUTPUT_FORMATS)[number];

type ToolParams = {
	prompt: string;
	model?: string;
	outputFormat?: OutputFormat;
};

type ParsedCodexResponse = {
	image?: {
		id: string;
		status: string;
		result: string;
		revisedPrompt?: string;
	};
	text: string[];
	responseId?: string;
	usage?: unknown;
};

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "Image prompt. Be specific about subject, composition, style, text, and constraints." }),
	model: Type.Optional(Type.String({ description: `Codex routing model. Leave unset unless the user names a specific model; defaults to ${DEFAULT_MODEL}.` })),
	outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS, { default: "png", description: "Output image format. Defaults to png. Use jpeg for photos to shrink size, webp for web delivery, png when transparency or max quality matters." })),
});

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) throw new Error("OpenAI Codex auth token is not a JWT. Run /login again.");
	return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

function extractChatGptAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const authClaims = payload[JWT_CLAIM_PATH];
	if (!authClaims || typeof authClaims !== "object") throw new Error("OpenAI Codex token has no ChatGPT auth claims. Run /login again.");
	const accountId = (authClaims as Record<string, unknown>).chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) throw new Error("OpenAI Codex token has no chatgpt_account_id. Run /login again.");
	return accountId;
}

function extForFormat(format: OutputFormat): string {
	return format === "jpeg" ? "jpg" : format;
}

function mimeForFormat(format: OutputFormat): string {
	return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function sanitizePathPart(value: string, fallback: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+$/g, "");
	return sanitized || fallback;
}

function buildRequestBody(params: ToolParams, model: string, outputFormat: OutputFormat, sessionId: string) {
	return {
		model,
		store: false,
		stream: true,
		prompt_cache_key: sessionId,
		instructions: "Call the image_generation tool exactly once to generate the requested bitmap image.",
		input: [{ role: "user", content: [{ type: "input_text", text: params.prompt }] }],
		tools: [{ type: "image_generation", output_format: outputFormat }],
		tool_choice: "auto",
		parallel_tool_calls: false,
		text: { verbosity: "low" },
	};
}

function parseSseDataLines(chunk: string): string | undefined {
	const data = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	return data && data !== "[DONE]" ? data : undefined;
}

function handleEvent(event: any, parsed: ParsedCodexResponse): void {
	if (!event || typeof event !== "object") return;
	if (event.type === "error") throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
	if (event.type === "response.failed") throw new Error(event.response?.error?.message || "Codex response failed.");
	if (event.type === "response.created" && typeof event.response?.id === "string") parsed.responseId = event.response.id;
	if (event.type === "response.output_text.delta" && typeof event.delta === "string") parsed.text.push(event.delta);
	if (event.type === "response.completed") {
		if (typeof event.response?.id === "string") parsed.responseId = event.response.id;
		if (event.response?.usage) parsed.usage = event.response.usage;
	}
	if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
		if (typeof event.item.result !== "string" || event.item.result.length === 0) throw new Error("Codex image_generation_call did not contain image data.");
		parsed.image = {
			id: String(event.item.id || "image_generation"),
			status: String(event.item.status || "completed"),
			result: event.item.result,
			revisedPrompt: typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : undefined,
		};
	}
}

async function parseCodexSse(response: Response, signal?: AbortSignal): Promise<ParsedCodexResponse> {
	if (!response.body) throw new Error("Codex response did not include a stream body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const parsed: ParsedCodexResponse = { text: [] };
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Image generation was aborted.");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let separator = buffer.indexOf("\n\n");
			while (separator !== -1) {
				const chunk = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				const data = parseSseDataLines(chunk);
				if (data) handleEvent(JSON.parse(data), parsed);
				separator = buffer.indexOf("\n\n");
			}
		}
		const remaining = parseSseDataLines(buffer);
		if (remaining) handleEvent(JSON.parse(remaining), parsed);
	} finally {
		try { await reader.cancel(); } catch {}
		reader.releaseLock();
	}
	return parsed;
}

async function saveImage(base64Data: string, outputFormat: OutputFormat, sessionId: string, imageId: string): Promise<string> {
	const safeSessionId = sanitizePathPart(sessionId, "session");
	const outputDir = join(getAgentDir(), "generated-images", safeSessionId);
	const filePath = join(outputDir, `${sanitizePathPart(imageId, "image_generation")}.${extForFormat(outputFormat)}`);
	await withFileMutationQueue(filePath, async () => {
		await mkdir(outputDir, { recursive: true });
		await writeFile(filePath, Buffer.from(base64Data, "base64"));
	});
	return filePath;
}

async function requestImage(params: ToolParams, token: string, accountId: string, model: string, outputFormat: OutputFormat, sessionId: string, signal?: AbortSignal) {
	const response = await fetch(CODEX_RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountId,
			originator: "pi",
			"OpenAI-Beta": OPENAI_BETA_HEADER,
			accept: "text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify(buildRequestBody(params, model, outputFormat, sessionId)),
		signal,
	});
	if (!response.ok) throw new Error(`Codex image request failed (${response.status}): ${await response.text()}`);
	return parseCodexSse(response, signal);
}

export default function codexImage(pi: any) {
	pi.registerTool({
		name: "codex_image",
		label: "codex-image",
		description: "Generate a bitmap image from a text prompt via the ChatGPT/Codex image_generation backend, using the existing openai-codex login. Use ONLY when the user explicitly asks to create, generate, draw, or render an image; never call it to illustrate an answer unprompted. Returns the image inline and saves it to the agent directory. Requires a ChatGPT Plus/Pro (Codex) login.",
		promptSnippet: "Use codex_image to generate bitmap images through ChatGPT/Codex when explicitly requested.",
		parameters: TOOL_PARAMS,
		executionMode: "parallel",
		async execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const outputFormat = params.outputFormat || "png";
			const requestedModel = params.model || DEFAULT_MODEL;
			const model = ctx.modelRegistry.find(PROVIDER, requestedModel)?.id || requestedModel;
			const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (!token) throw new Error(`Missing ${PROVIDER} credentials. Run /login and select ChatGPT Plus/Pro (Codex).`);
			const accountId = extractChatGptAccountId(token);
			const sessionId = ctx.sessionManager.getSessionId();

			onUpdate?.({ content: [{ type: "text", text: `Requesting image generation through ${PROVIDER}/${model}...` }] });
			const parsed = await requestImage(params, token, accountId, model, outputFormat, sessionId, signal);
			if (!parsed.image) {
				const text = parsed.text.join("").trim();
				throw new Error(text ? `Codex did not return an image. Response text: ${text}` : "Codex did not return an image.");
			}

			const savedPath = await saveImage(parsed.image.result, outputFormat, sessionId, parsed.image.id || toolCallId);
			return {
				content: [
					{ type: "text", text: `Generated image via ${PROVIDER}/${model}. Saved image to: ${savedPath}` },
					{ type: "image", data: parsed.image.result, mimeType: mimeForFormat(outputFormat) },
				],
				details: { provider: PROVIDER, model, backendImageModel: "gpt-image-2", outputFormat, savedPath, responseId: parsed.responseId, usage: parsed.usage },
			};
		},
	});
}
