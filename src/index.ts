declare global {
	interface Env {
		API_KEY: string;
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		const authError = checkAuth(request, env);
		if (authError) return authError;

		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, "") || "/";

		try {
			if (path === "/engines/v1/models" || path === "/v1/models") {
				return listModels(env);
			}
			if (path.startsWith("/engines/v1/models/") || path.startsWith("/v1/models/")) {
				return getModel(path, env);
			}
			if (path === "/engines/v1/chat/completions" || path === "/v1/chat/completions") {
				return chatCompletions(request, env);
			}
			if (path === "/engines/v1/completions" || path === "/v1/completions") {
				return completions(request, env);
			}
			if (path === "/engines/v1/embeddings" || path === "/v1/embeddings") {
				return embeddings(request, env);
			}
			if (path === "/engines/v1/vectorize" || path === "/v1/vectorize") {
				return vectorizeDescribe(env);
			}
			if (path === "/engines/v1/vectorize/upsert" || path === "/v1/vectorize/upsert") {
				return vectorizeUpsert(request, env);
			}
			if (path === "/engines/v1/vectorize/query" || path === "/v1/vectorize/query") {
				return vectorizeQuery(request, env);
			}
			if (path === "/engines/v1/vectorize/delete" || path === "/v1/vectorize/delete") {
				return vectorizeDelete(request, env);
			}
			if (path === "/" || path === "/engines" || path === "/engines/v1" || path === "/v1") {
				return jsonResponse({ object: "list", data: [modelObject(env)] });
			}
			return errorResponse(`Unknown endpoint: ${url.pathname}`, 404, "not_found");
		} catch (err) {
			console.error("Unhandled error", err);
			return errorResponse("Internal server error", 500, "server_error");
		}
	},
} satisfies ExportedHandler<Env>;

const DEFAULT_EXPOSED_MODEL = "deepseek-v4.1-flash-cloudflare";
const DEFAULT_CLOUDFLARE_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

type AiRunLike = {
	run(
		model: string,
		inputs: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<unknown>;
};

function exposedModel(env: Env): string {
	return env.EXPOSED_MODEL ?? DEFAULT_EXPOSED_MODEL;
}

function cloudflareModel(env: Env): string {
	return env.CLOUDFLARE_MODEL ?? DEFAULT_CLOUDFLARE_MODEL;
}

function embeddingModel(env: Env): string {
	return env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
}

function corsHeaders(): Record<string, string> {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "Authorization, Content-Type, x-api-key",
	};
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
	return Response.json(body, { status, headers: { ...corsHeaders(), ...extraHeaders } });
}

function errorResponse(message: string, status: number, type: string): Response {
	return jsonResponse(
		{ error: { message, type, code: status } },
		status,
	);
}

function checkAuth(request: Request, env: Env): Response | null {
	const expected = env.API_KEY;
	if (!expected) {
		return errorResponse("Server is not configured: API_KEY is missing.", 500, "server_error");
	}
	const header = request.headers.get("Authorization") ?? "";
	const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
	const provided = bearer || (request.headers.get("x-api-key") ?? "").trim();
	if (provided !== expected) {
		return errorResponse(
			"Incorrect API key provided. Use the 'Authorization: Bearer <key>' header.",
			401,
			"invalid_request_error",
		);
	}
	return null;
}

function modelObject(env: Env) {
	return {
		id: exposedModel(env),
		object: "model",
		created: 1700000000,
		owned_by: "cloudflare",
	};
}

function listModels(env: Env): Response {
	return jsonResponse({ object: "list", data: [modelObject(env)] });
}

function getModel(path: string, env: Env): Response {
	const segments = path.split("/").filter(Boolean);
	const id = decodeURIComponent(segments[segments.length - 1] ?? "");
	if (id === exposedModel(env)) {
		return jsonResponse(modelObject(env));
	}
	return errorResponse(`No such model: '${id}'`, 404, "invalid_request_error");
}

function normalizeMessages(messages: unknown): unknown {
	if (!Array.isArray(messages)) return messages;
	return messages.map((m) => {
		if (m && typeof m === "object") {
			const rec = m as Record<string, unknown>;
			if (rec.content === null || rec.content === undefined) {
				return { ...rec, content: "" };
			}
		}
		return m;
	});
}

function buildRunPayload(body: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = { messages: normalizeMessages(body.messages) };
	const forwarded: Record<string, string> = {
		stream: "stream",
		max_tokens: "max_tokens",
		max_completion_tokens: "max_tokens",
		temperature: "temperature",
		top_p: "top_p",
		presence_penalty: "presence_penalty",
		frequency_penalty: "frequency_penalty",
		stop: "stop",
		seed: "seed",
		tools: "tools",
		tool_choice: "tool_choice",
		parallel_tool_calls: "parallel_tool_calls",
		response_format: "response_format",
		logprobs: "logprobs",
		top_logprobs: "top_logprobs",
		reasoning_effort: "reasoning_effort",
		chat_template_kwargs: "chat_template_kwargs",
		function_call: "function_call",
		functions: "functions",
		user: "user",
		metadata: "metadata",
		n: "n",
		stream_options: "stream_options",
	};
	for (const [src, dst] of Object.entries(forwarded)) {
		const value = body[src];
		if (value !== undefined && value !== null) {
			payload[dst] = value;
		}
	}
	return payload;
}

async function runAI(env: Env, payload: Record<string, unknown>): Promise<unknown> {
	const ai = env.AI as unknown as AiRunLike;
	return ai.run(cloudflareModel(env), payload);
}

function randomId(): string {
	return crypto.randomUUID();
}

function stringifyArgs(args: unknown): string {
	if (typeof args === "string") return args;
	if (args === undefined || args === null) return "{}";
	try {
		return JSON.stringify(args);
	} catch {
		return "{}";
	}
}

function normalizeToolCalls(calls: unknown): unknown[] | undefined {
	if (!Array.isArray(calls) || calls.length === 0) return undefined;
	return calls.map((tc) => {
		const call = (tc ?? {}) as Record<string, unknown>;
		const fn = call.function as Record<string, unknown> | undefined;
		if (fn && typeof fn === "object" && typeof fn.name === "string") {
			return {
				id: typeof call.id === "string" ? call.id : `call_${randomId()}`,
				type: "function",
				function: { name: fn.name, arguments: stringifyArgs(fn.arguments) },
			};
		}
		return {
			id: typeof call.id === "string" ? call.id : `call_${randomId()}`,
			type: "function",
			function: {
				name: typeof call.name === "string" ? call.name : "",
				arguments: stringifyArgs(call.arguments),
			},
		};
	});
}

function isNullFinalizationToolCall(call: Record<string, unknown>): boolean {
	const fn = asRecord(call.function);
	const id = typeof call.id === "string" ? call.id : null;
	const name = typeof fn.name === "string" ? fn.name : null;
	const args = typeof fn.arguments === "string" ? fn.arguments : null;
	return !id && !name && (!args || args === "");
}

function normalizeStreamToolCalls(calls: unknown): unknown[] | undefined {
	if (!Array.isArray(calls)) return undefined;
	const out: unknown[] = [];
	for (const tc of calls) {
		const call = asRecord(tc);
		if (isNullFinalizationToolCall(call)) continue;
		const fn = asRecord(call.function);
		const normalized: Record<string, unknown> = {};
		if (typeof call.index === "number") normalized.index = call.index;
		if (typeof call.id === "string" && call.id) normalized.id = call.id;
		if (typeof call.type === "string" && call.type) normalized.type = call.type;
		const fnOut: Record<string, unknown> = {};
		if (typeof fn.name === "string" && fn.name) fnOut.name = fn.name;
		const args = fn.arguments;
		fnOut.arguments =
			args !== undefined && args !== null
				? typeof args === "string"
					? args
					: stringifyArgs(args)
				: "";
		normalized.function = fnOut;
		out.push(normalized);
	}
	return out.length > 0 ? out : undefined;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function normalizeUsage(usage: unknown): Record<string, unknown> {
	const u = (usage ?? {}) as Record<string, unknown>;
	const promptTokens = toNumber(u.prompt_tokens) ?? toNumber(u.input_tokens) ?? 0;
	const completionTokens = toNumber(u.completion_tokens) ?? toNumber(u.output_tokens) ?? 0;
	const normalized: Record<string, unknown> = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
	};
	if (u.prompt_tokens_details && typeof u.prompt_tokens_details === "object") {
		normalized.prompt_tokens_details = u.prompt_tokens_details;
	}
	return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeChatCompletion(result: unknown, model: string): Record<string, unknown> {
	const rec = asRecord(result);
	const id = typeof rec.id === "string" ? rec.id : `chatcmpl-${randomId()}`;
	const created =
		typeof rec.created === "number" ? rec.created : Math.floor(Date.now() / 1000);

	const choices = rec.choices as Array<Record<string, unknown>> | undefined;
	let content: string | null = null;
	let reasoning: string | null = null;
	let toolCalls: unknown[] | undefined;
	let finishReason = "stop";

	if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
		const choice = asRecord(choices[0]);
		const message = asRecord(choice.message);
		if (typeof message.content === "string") content = message.content;
		if (typeof message.reasoning_content === "string") reasoning = message.reasoning_content;
		if (reasoning === null && typeof message.reasoning === "string") {
			reasoning = message.reasoning;
		}
		toolCalls = normalizeToolCalls(message.tool_calls);
		if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
	} else {
		if (typeof rec.response === "string") content = rec.response;
		if (typeof rec.reasoning_content === "string") reasoning = rec.reasoning_content;
		if (reasoning === null && typeof rec.reasoning === "string") reasoning = rec.reasoning;
		toolCalls = normalizeToolCalls(rec.tool_calls);
		if (typeof rec.finish_reason === "string") finishReason = rec.finish_reason;
	}

	const message: Record<string, unknown> = { role: "assistant", content: content ?? "" };
	if (reasoning) {
		message.reasoning_content = reasoning;
		message.reasoning = reasoning;
	}
	if (toolCalls) message.tool_calls = toolCalls;

	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [
			{ index: 0, message, finish_reason: finishReason, logprobs: null },
		],
		usage: normalizeUsage(rec.usage),
	};
}

async function* parseWorkersAISSE(source: ReadableStream) {
	const reader = source.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				yield* handleSseLine(line);
			}
		}
		const tail = buffer.trim();
		if (tail) yield* handleSseLine(tail);
	} finally {
		reader.releaseLock();
	}
}

function* handleSseLine(line: string) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return;
	const payload = trimmed.slice(5).trim();
	if (!payload) return;
	if (payload === "[DONE]") {
		yield null;
		return;
	}
	try {
		yield JSON.parse(payload);
	} catch {
		// ignore malformed SSE events
	}
}

async function streamChatResponse(
	result: unknown,
	env: Env,
): Promise<Response> {
	const model = exposedModel(env);
	const id = `chatcmpl-${randomId()}`;
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();

	if (!(result instanceof ReadableStream)) {
		const normalized = normalizeChatCompletion(result, model);
		const normalizedChoices = normalized.choices as Array<Record<string, unknown>>;
		const message = (normalizedChoices[0]?.message ?? {}) as Record<string, unknown>;
		const content = typeof message.content === "string" ? message.content : "";
		const reasoning =
			typeof message.reasoning === "string" ? (message.reasoning as string) : null;
		const output = [
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
		];
		if (reasoning) {
			output.push(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning, reasoning_content: reasoning }, finish_reason: null }] })}\n\n`,
			);
		}
		if (content) {
			output.push(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
			);
		}
		output.push(
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: normalized.usage })}\n\n`,
		);
		output.push("data: [DONE]\n\n");
		return new Response(output.join(""), {
			status: 200,
			headers: sseHeaders(),
		});
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (obj: unknown) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

			send({
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
			});

			let usage: Record<string, unknown> | null = null;
			let finishReason: string | null = null;

			try {
				for await (const chunk of parseWorkersAISSE(result)) {
					if (!chunk) continue;
					const rec = asRecord(chunk);
					const choices = rec.choices as Array<Record<string, unknown>> | undefined;
					const delta: Record<string, unknown> = {};

					if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
						const choice = asRecord(choices[0]);
						if (typeof choice.finish_reason === "string") {
							finishReason = choice.finish_reason;
						}
						const d = asRecord(choice.delta);
						if (typeof d.content === "string" && d.content) delta.content = d.content;
						const reasoning =
							typeof d.reasoning_content === "string"
								? d.reasoning_content
								: typeof d.reasoning === "string"
									? d.reasoning
									: null;
						if (reasoning) {
							delta.reasoning = reasoning;
							delta.reasoning_content = reasoning;
						}
						const tc = normalizeStreamToolCalls(d.tool_calls);
						if (tc) delta.tool_calls = tc;
					} else {
						if (typeof rec.response === "string" && rec.response) {
							delta.content = rec.response;
						}
						const reasoning =
							typeof rec.reasoning_content === "string"
								? rec.reasoning_content
								: typeof rec.reasoning === "string"
									? rec.reasoning
									: null;
						if (reasoning) {
							delta.reasoning = reasoning;
							delta.reasoning_content = reasoning;
						}
						const tc = normalizeStreamToolCalls(rec.tool_calls);
						if (tc) delta.tool_calls = tc;
						if (typeof rec.finish_reason === "string") {
							finishReason = rec.finish_reason;
						}
					}

					if (Object.keys(delta).length > 0) {
						send({
							id,
							object: "chat.completion.chunk",
							created,
							model,
							choices: [{ index: 0, delta, finish_reason: null }],
						});
					}

					if (rec.usage !== undefined) {
						usage = normalizeUsage(rec.usage);
					}
				}
			} catch (err) {
				console.error("Streaming error", err);
			}

			send({
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }],
				usage: usage ?? {},
			});
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});

	return new Response(stream, { status: 200, headers: sseHeaders() });
}

function sseHeaders(): Record<string, string> {
	return {
		...corsHeaders(),
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
	};
}

function mapAIError(err: unknown): Response {
	const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
	const message =
		typeof rec.message === "string"
			? rec.message
			: err instanceof Error
				? err.message
				: "Upstream model request failed.";
	const status = typeof rec.status === "number" ? rec.status : 502;
	return errorResponse(message, status, "api_error");
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
	const ai = env.AI as unknown as AiRunLike;
	const result = await ai.run(embeddingModel(env), { text: texts });
	const rec = asRecord(result);
	const data = rec.data;
	if (!Array.isArray(data)) {
		throw new Error("Unexpected embedding response format from Workers AI.");
	}
	return data.map((v) => Array.from(v as ArrayLike<number>));
}

function lastUserMessageText(messages: unknown): string | null {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = asRecord(messages[i]);
		if (m.role !== "user") continue;
		const content = m.content;
		if (typeof content === "string" && content.trim()) return content;
		if (Array.isArray(content)) {
			const joined = content
				.map((p) => {
					const part = asRecord(p);
					return typeof part.text === "string" ? part.text : "";
				})
				.join(" ")
				.trim();
			if (joined) return joined;
		}
	}
	return null;
}

function metadataText(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object") return null;
	const md = metadata as Record<string, unknown>;
	if (typeof md.text === "string" && md.text) return md.text;
	if (typeof md.content === "string" && md.content) return md.content;
	const serialized = JSON.stringify(md);
	return serialized && serialized !== "{}" ? serialized : null;
}

function requireVectorize(env: Env): Response | null {
	if (!env.VECTORIZE) {
		return errorResponse(
			"Vectorize is not configured on this worker.",
			503,
			"vectorize_not_configured",
		);
	}
	return null;
}

async function embeddings(request: Request, env: Env): Promise<Response> {
	const body: unknown = await request.json().catch(() => null);
	const rec = asRecord(body);
	const input = rec.input;
	if (input === undefined || input === null) {
		return errorResponse("Invalid request: 'input' is required.", 400, "invalid_request_error");
	}
	const texts = Array.isArray(input) ? input.map(String) : [String(input)];
	if (texts.length === 0 || texts.some((t) => t === "")) {
		return errorResponse(
			"Invalid request: 'input' must contain non-empty strings.",
			400,
			"invalid_request_error",
		);
	}
	try {
		const data = await embedTexts(env, texts);
		return jsonResponse({
			object: "list",
			data: data.map((embedding, index) => ({
				object: "embedding",
				index,
				embedding,
			})),
			model: typeof rec.model === "string" ? rec.model : embeddingModel(env),
			usage: { prompt_tokens: texts.length, total_tokens: texts.length },
		});
	} catch (err) {
		return mapAIError(err);
	}
}

async function vectorizeDescribe(env: Env): Promise<Response> {
	const missing = requireVectorize(env);
	if (missing) return missing;
	try {
		const info = await env.VECTORIZE.describe();
		return jsonResponse({ index: "deepseek-memory", ...info });
	} catch (err) {
		return mapAIError(err);
	}
}

async function vectorizeUpsert(request: Request, env: Env): Promise<Response> {
	const missing = requireVectorize(env);
	if (missing) return missing;
	const body: unknown = await request.json().catch(() => null);
	const rec = asRecord(body);
	const documents = rec.documents;
	if (!Array.isArray(documents) || documents.length === 0) {
		return errorResponse(
			"Invalid request: 'documents' (array of { id, text, metadata? }) is required.",
			400,
			"invalid_request_error",
		);
	}
	if (documents.length > 1000) {
		return errorResponse(
			"Too many documents. Maximum 1000 per batch.",
			400,
			"invalid_request_error",
		);
	}
	const entries: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [];
	for (const d of documents) {
		const doc = asRecord(d);
		if (typeof doc.id !== "string" || doc.id === "") {
			return errorResponse(
				"Each document requires a non-empty string 'id'.",
				400,
				"invalid_request_error",
			);
		}
		if (typeof doc.text !== "string" || doc.text === "") {
			return errorResponse(
				"Each document requires a non-empty string 'text'.",
				400,
				"invalid_request_error",
			);
		}
		entries.push({
			id: doc.id,
			text: doc.text,
			metadata:
				doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
					? (doc.metadata as Record<string, unknown>)
					: undefined,
		});
	}
	try {
		const data = await embedTexts(
			env,
			entries.map((e) => e.text),
		);
		const namespace = typeof rec.namespace === "string" && rec.namespace ? rec.namespace : undefined;
		const vectors: VectorizeVector[] = entries.map((e, i) => ({
			id: e.id,
			values: data[i],
			metadata: { ...(e.metadata ?? {}), text: e.text } as VectorizeVector["metadata"],
			...(namespace ? { namespace } : {}),
		}));
		const mutation = await env.VECTORIZE.upsert(vectors);
		return jsonResponse({ success: true, count: vectors.length, mutation });
	} catch (err) {
		return mapAIError(err);
	}
}

async function vectorizeQuery(request: Request, env: Env): Promise<Response> {
	const missing = requireVectorize(env);
	if (missing) return missing;
	const body: unknown = await request.json().catch(() => null);
	const rec = asRecord(body);
	const query = rec.query;
	if (typeof query !== "string" || query.trim() === "") {
		return errorResponse("Invalid request: 'query' (string) is required.", 400, "invalid_request_error");
	}
	const topK =
		typeof rec.topK === "number" ? Math.max(1, Math.min(50, Math.floor(rec.topK))) : 5;
	try {
		const [vector] = await embedTexts(env, [query]);
		const options: VectorizeQueryOptions = {
			topK,
			returnMetadata:
				rec.returnMetadata === true || rec.returnMetadata === "all"
					? "all"
					: rec.returnMetadata === "indexed"
						? "indexed"
						: "none",
		};
		if (rec.returnValues === true) options.returnValues = true;
		if (typeof rec.namespace === "string" && rec.namespace) options.namespace = rec.namespace;
		if (rec.filter && typeof rec.filter === "object") {
			options.filter = rec.filter as VectorizeVectorMetadataFilter;
		}
		const matches = await env.VECTORIZE.query(vector, options);
		return jsonResponse(matches);
	} catch (err) {
		return mapAIError(err);
	}
}

async function vectorizeDelete(request: Request, env: Env): Promise<Response> {
	const missing = requireVectorize(env);
	if (missing) return missing;
	const body: unknown = await request.json().catch(() => null);
	const rec = asRecord(body);
	const ids = rec.ids;
	if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== "string")) {
		return errorResponse(
			"Invalid request: 'ids' (array of strings) is required.",
			400,
			"invalid_request_error",
		);
	}
	try {
		const mutation = await env.VECTORIZE.deleteByIds(ids as string[]);
		return jsonResponse({ success: true, count: (ids as string[]).length, mutation });
	} catch (err) {
		return mapAIError(err);
	}
}

async function chatCompletions(request: Request, env: Env): Promise<Response> {
	const body: unknown = await request.json().catch(() => null);
	const rec = asRecord(body);
	if (!Array.isArray(rec.messages)) {
		return errorResponse(
			"Invalid request: 'messages' is required and must be an array.",
			400,
			"invalid_request_error",
		);
	}

	let messages = rec.messages;
	const vectorizeOpts = asRecord(rec.vectorize);
	if (vectorizeOpts.retrieve === true && env.VECTORIZE) {
		const query = lastUserMessageText(rec.messages);
		if (query) {
			try {
				const topK =
					typeof vectorizeOpts.topK === "number"
						? Math.max(1, Math.min(50, Math.floor(vectorizeOpts.topK)))
						: 5;
				const [vector] = await embedTexts(env, [query]);
				const options: VectorizeQueryOptions = { topK, returnMetadata: "all" };
				if (typeof vectorizeOpts.namespace === "string" && vectorizeOpts.namespace) {
					options.namespace = vectorizeOpts.namespace;
				}
				const matches = await env.VECTORIZE.query(vector, options);
				const context = matches.matches
					.map((m) => metadataText(m.metadata))
					.filter((t): t is string => t !== null && t !== "")
					.join("\n\n---\n\n");
				if (context) {
					messages = [
						{ role: "system", content: `Contexto recuperado de la base vectorial:\n${context}` },
						...messages,
					];
				}
			} catch (err) {
				console.error("RAG retrieval failed", err);
			}
		}
	}

	const payload = buildRunPayload({ ...rec, messages });
	try {
		const result = await runAI(env, payload);
		if (rec.stream) {
			return streamChatResponse(result, env);
		}
		return jsonResponse(normalizeChatCompletion(result, exposedModel(env)));
	} catch (err) {
		return mapAIError(err);
	}
}

function toTextCompletion(chat: Record<string, unknown>): Record<string, unknown> {
	const choice = (chat.choices as Array<Record<string, unknown>>)[0] ?? {};
	const message = asRecord(choice.message);
	return {
		id: typeof chat.id === "string" ? chat.id.replace("chatcmpl-", "cmpl-") : `cmpl-${randomId()}`,
		object: "text_completion",
		created: chat.created,
		model: chat.model,
		choices: [
			{
				index: 0,
				text: typeof message.content === "string" ? message.content : "",
				logprobs: null,
				finish_reason: choice.finish_reason ?? "stop",
			},
		],
		usage: chat.usage,
	};
}

async function completions(request: Request, env: Env): Promise<Response> {
	const body: unknown = await request.json().catch(() => null);
	const rec = asRecord(body);
	const prompt = rec.prompt;
	if (prompt === undefined || prompt === null) {
		return errorResponse("Invalid request: 'prompt' is required.", 400, "invalid_request_error");
	}
	const text = Array.isArray(prompt) ? prompt.map(String).join("") : String(prompt);
	const chatBody: Record<string, unknown> = { ...rec, messages: [{ role: "user", content: text }] };
	delete chatBody.prompt;

	try {
		const result = await runAI(env, buildRunPayload(chatBody));
		const normalized = normalizeChatCompletion(result, exposedModel(env));

		if (rec.stream) {
			const model = exposedModel(env);
			const id =
				typeof normalized.id === "string"
					? normalized.id.replace("chatcmpl-", "cmpl-")
					: `cmpl-${randomId()}`;
			const created = normalized.created ?? Math.floor(Date.now() / 1000);
			const choice = asRecord((normalized.choices as Array<Record<string, unknown>>)[0]);
			const message = asRecord(choice.message);
			const textContent = typeof message.content === "string" ? message.content : "";
			const output = [
				`data: ${JSON.stringify({ id, object: "text_completion", created, model, choices: [{ index: 0, text: textContent, logprobs: null, finish_reason: "stop" }] })}\n\n`,
				"data: [DONE]\n\n",
			];
			return new Response(output.join(""), { status: 200, headers: sseHeaders() });
		}

		return jsonResponse(toTextCompletion(normalized));
	} catch (err) {
		return mapAIError(err);
	}
}