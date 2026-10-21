import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const API_KEY = "pass123";
const EXPOSED_MODEL = "deepseek-v4.1-flash-cloudflare";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

type MockAI = {
	run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
};

function makeEnv(ai: MockAI, overrides: Record<string, unknown> = {}) {
	return {
		API_KEY,
		EXPOSED_MODEL,
		CLOUDFLARE_MODEL: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
		AI: ai,
		...overrides,
	} as unknown as Env;
}

async function fetchWith(
	env: Env,
	url: string,
	init: RequestInit<IncomingRequestCfProperties> = {},
): Promise<Response> {
	const request = new IncomingRequest(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function authHeaders(overrides: Record<string, string> = {}): Record<string, string> {
	return { authorization: `Bearer ${API_KEY}`, ...overrides };
}

describe("auth", () => {
	it("rejects requests without an API key", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(env, "https://example.com/engines/v1/models");
		expect(response.status).toBe(401);
	});

	it("rejects requests with a wrong API key", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(env, "https://example.com/engines/v1/models", {
			headers: authHeaders({ authorization: "Bearer wrong" }),
		});
		expect(response.status).toBe(401);
	});

	it("accepts requests with the correct API key", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(env, "https://example.com/engines/v1/models", {
			headers: authHeaders(),
		});
		expect(response.status).toBe(200);
	});
});

describe("models", () => {
	it("lists the exposed model", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(env, "https://example.com/engines/v1/models", {
			headers: authHeaders(),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.object).toBe("list");
		const data = body.data as Array<Record<string, unknown>>;
		expect(data[0].id).toBe(EXPOSED_MODEL);
	});

	it("retrieves the exposed model", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(
			env,
			`https://example.com/engines/v1/models/${EXPOSED_MODEL}`,
			{ headers: authHeaders() },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.id).toBe(EXPOSED_MODEL);
	});

	it("returns 404 for unknown models", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/models/nope",
			{ headers: authHeaders() },
		);
		expect(response.status).toBe(404);
	});
});

describe("chat completions", () => {
	it("forwards messages and returns OpenAI-format response (native format)", async () => {
		const run = vi.fn().mockResolvedValue({
			response: "Hello!",
			usage: { input_tokens: 5, output_tokens: 2 },
		});
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					model: EXPOSED_MODEL,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.object).toBe("chat.completion");
		expect(body.model).toBe(EXPOSED_MODEL);
		const choice = (body.choices as Array<Record<string, unknown>>)[0];
		const message = choice.message as Record<string, unknown>;
		expect(message.content).toBe("Hello!");
		expect(choice.finish_reason).toBe("stop");
		const usage = body.usage as Record<string, unknown>;
		expect(usage.prompt_tokens).toBe(5);
		expect(usage.completion_tokens).toBe(2);
		expect(usage.total_tokens).toBe(7);
	});

	it("maps max_completion_tokens to max_tokens when forwarding", async () => {
		const run = vi.fn().mockResolvedValue({ response: "ok" });
		const env = makeEnv({ run });

		await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					model: EXPOSED_MODEL,
					messages: [{ role: "user", content: "hi" }],
					max_completion_tokens: 123,
					temperature: 0.7,
				}),
			},
		);

		expect(run).toHaveBeenCalledOnce();
		const [, inputs] = run.mock.calls[0] as [string, Record<string, unknown>];
		expect(inputs.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(inputs.max_tokens).toBe(123);
		expect(inputs.temperature).toBe(0.7);
	});

	it("normalizes native tool calls to OpenAI format", async () => {
		const run = vi.fn().mockResolvedValue({
			response: null,
			tool_calls: [{ name: "getWeather", arguments: { city: "london" } }],
		});
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					model: EXPOSED_MODEL,
					messages: [{ role: "user", content: "weather?" }],
					tools: [
						{
							type: "function",
							function: { name: "getWeather", description: "x", parameters: {} },
						},
					],
				}),
			},
		);

		const body = (await response.json()) as Record<string, unknown>;
		const message = (body.choices as Array<Record<string, unknown>>)[0]
			.message as Record<string, unknown>;
		const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
		expect(toolCalls[0].type).toBe("function");
		expect((toolCalls[0].function as Record<string, unknown>).name).toBe("getWeather");
		expect((toolCalls[0].function as Record<string, unknown>).arguments).toBe(
			JSON.stringify({ city: "london" }),
		);
	});

	it("preserves reasoning from OpenAI-format responses", async () => {
		const run = vi.fn().mockResolvedValue({
			choices: [
				{
					message: { content: "Answer", reasoning_content: "thinking..." },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		});
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ model: EXPOSED_MODEL, messages: [{ role: "user", content: "hi" }] }),
			},
		);

		const body = (await response.json()) as Record<string, unknown>;
		const message = (body.choices as Array<Record<string, unknown>>)[0]
			.message as Record<string, unknown>;
		expect(message.content).toBe("Answer");
		expect(message.reasoning_content).toBe("thinking...");
		expect(message.reasoning).toBe("thinking...");
	});

	it("returns a 400 when messages is missing", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ model: EXPOSED_MODEL }),
			},
		);
		expect(response.status).toBe(400);
	});

	it("streams native Workers AI SSE as OpenAI chat.completion.chunk events", async () => {
		const run = vi.fn().mockResolvedValue(
			sseStream([
				'data: {"response":"Hel"}\n\n',
				'data: {"response":"lo"}\n\n',
				'data: {"usage":{"input_tokens":3,"output_tokens":2}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					model: EXPOSED_MODEL,
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const text = await response.text();
		expect(text).toContain('"object":"chat.completion.chunk"');
		expect(text).toContain('"content":"Hel"');
		expect(text).toContain('"content":"lo"');
		expect(text).toContain('"finish_reason":"stop"');
		expect(text.trim().endsWith("data: [DONE]")).toBe(true);
	});

	it("streams OpenAI-format tool call deltas without corrupting arguments", async () => {
		const run = vi.fn().mockResolvedValue(
			sseStream([
				'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"","name":"bash"},"id":"call_abc","index":0,"type":"function"}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"command\\"","name":null},"id":null,"index":0,"type":"function"}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":": \\"echo hi\\"}","name":null},"id":null,"index":0,"type":"function"}]},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					model: EXPOSED_MODEL,
					stream: true,
					messages: [{ role: "user", content: "run ls" }],
					tools: [
						{
							type: "function",
							function: { name: "bash", description: "x", parameters: {} },
						},
					],
				}),
			},
		);

		const text = await response.text();
		expect(text).toContain('"id":"call_abc"');
		expect(text).toContain('"arguments":"{\\"command\\""');
		expect(text).not.toContain('"arguments":"{}"');
		expect(text).toContain('"finish_reason":"tool_calls"');
		expect(text.trim().endsWith("data: [DONE]")).toBe(true);
		const toolCallIds = text.match(/"id":"call_/g) ?? [];
		expect(toolCallIds.length).toBe(1);
	});

	it("gracefully wraps a non-streaming result when streaming was requested", async () => {
		const run = vi.fn().mockResolvedValue({ response: "Full answer" });
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					model: EXPOSED_MODEL,
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
		);

		const text = await response.text();
		expect(text).toContain('"content":"Full answer"');
		expect(text.trim().endsWith("data: [DONE]")).toBe(true);
	});
});

describe("completions", () => {
	it("converts a prompt into a text completion", async () => {
		const run = vi.fn().mockResolvedValue({ response: "A text completion" });
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ model: EXPOSED_MODEL, prompt: "hello" }),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.object).toBe("text_completion");
		const choice = (body.choices as Array<Record<string, unknown>>)[0];
		expect(choice.text).toBe("A text completion");
	});
});

describe("embeddings", () => {
	it("returns OpenAI-format embeddings", async () => {
		const run = vi
			.fn()
			.mockResolvedValue({ data: [[0.1, 0.2], [0.3, 0.4]], shape: [2, 2] });
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/embeddings",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ model: EXPOSED_MODEL, input: ["hola", "mundo"] }),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.object).toBe("list");
		const data = body.data as Array<Record<string, unknown>>;
		expect(data[0].object).toBe("embedding");
		expect(data[0].index).toBe(0);
		expect(data[0].embedding).toEqual([0.1, 0.2]);
		expect(data[1].embedding).toEqual([0.3, 0.4]);
		expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", { text: ["hola", "mundo"] });
	});

	it("accepts a single string input", async () => {
		const run = vi.fn().mockResolvedValue({ data: [[0.5, 0.6]] });
		const env = makeEnv({ run });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/embeddings",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ input: "hola" }),
			},
		);

		expect(response.status).toBe(200);
		expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", { text: ["hola"] });
	});

	it("rejects missing input", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/embeddings",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(response.status).toBe(400);
	});
});

describe("vectorize", () => {
	function vectorizeMock() {
		return {
			describe: vi.fn(),
			query: vi.fn(),
			upsert: vi.fn(),
			deleteByIds: vi.fn(),
			insert: vi.fn(),
			getByIds: vi.fn(),
		};
	}

	it("returns 503 when Vectorize is not bound", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/vectorize/query",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ query: "hola" }),
			},
		);
		expect(response.status).toBe(503);
	});

	it("upserts embedded documents", async () => {
		const run = vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] });
		const vectorize = vectorizeMock();
		vectorize.upsert.mockResolvedValue({ mutationId: "mut-1" });
		const env = makeEnv({ run }, { VECTORIZE: vectorize });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/vectorize/upsert",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					documents: [{ id: "doc1", text: "hola mundo", metadata: { source: "test" } }],
				}),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.success).toBe(true);
		expect(body.count).toBe(1);
		expect(vectorize.upsert).toHaveBeenCalledWith([
			{
				id: "doc1",
				values: [0.1, 0.2],
				metadata: { source: "test", text: "hola mundo" },
			},
		]);
	});

	it("stores the document text in metadata so RAG can retrieve it", async () => {
		const run = vi.fn().mockResolvedValue({ data: [[0.3, 0.4]] });
		const vectorize = vectorizeMock();
		vectorize.upsert.mockResolvedValue({ mutationId: "mut-3" });
		const env = makeEnv({ run }, { VECTORIZE: vectorize });

		await fetchWith(env, "https://example.com/engines/v1/vectorize/upsert", {
			method: "POST",
			headers: { ...authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ documents: [{ id: "doc9", text: "contenido relevante" }] }),
		});

		expect(vectorize.upsert).toHaveBeenCalledWith([
			{
				id: "doc9",
				values: [0.3, 0.4],
				metadata: { text: "contenido relevante" },
			},
		]);
	});

	it("queries with an embedded query vector", async () => {
		const run = vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] });
		const vectorize = vectorizeMock();
		vectorize.query.mockResolvedValue({
			count: 1,
			matches: [{ id: "doc1", score: 0.91 }],
		});
		const env = makeEnv({ run }, { VECTORIZE: vectorize });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/vectorize/query",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ query: "hola", topK: 3, returnValues: true }),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect((body as { count: number }).count).toBe(1);
		expect(vectorize.query).toHaveBeenCalledWith([0.1, 0.2], {
			topK: 3,
			returnMetadata: "none",
			returnValues: true,
		});
	});

	it("deletes vectors by id", async () => {
		const vectorize = vectorizeMock();
		vectorize.deleteByIds.mockResolvedValue({ mutationId: "mut-2" });
		const env = makeEnv({ run: vi.fn() }, { VECTORIZE: vectorize });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/vectorize/delete",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ ids: ["doc1", "doc2"] }),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.success).toBe(true);
		expect(body.count).toBe(2);
		expect(vectorize.deleteByIds).toHaveBeenCalledWith(["doc1", "doc2"]);
	});

	it("describes the index", async () => {
		const vectorize = vectorizeMock();
		vectorize.describe.mockResolvedValue({ dimensions: 1024, vectorCount: 3 });
		const env = makeEnv({ run: vi.fn() }, { VECTORIZE: vectorize });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/vectorize",
			{ headers: authHeaders() },
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.dimensions).toBe(1024);
		expect(body.vectorCount).toBe(3);
	});

	it("injects retrieved context into chat when vectorize.retrieve is true", async () => {
		const run = vi.fn().mockImplementation((model: string) => {
			if (model === "@cf/baai/bge-m3") {
				return Promise.resolve({ data: [[0.1, 0.2]] });
			}
			return Promise.resolve({ response: "ok" });
		});
		const vectorize = vectorizeMock();
		vectorize.query.mockResolvedValue({
			count: 1,
			matches: [
				{ id: "doc1", score: 0.9, metadata: { text: "El contexto relevante" } },
			],
		});
		const env = makeEnv({ run }, { VECTORIZE: vectorize });

		const response = await fetchWith(
			env,
			"https://example.com/engines/v1/chat/completions",
			{
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					model: EXPOSED_MODEL,
					messages: [{ role: "user", content: "dime algo" }],
					vectorize: { retrieve: true, topK: 2 },
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
		const lastCall = run.mock.calls[run.mock.calls.length - 1] as [
			string,
			Record<string, unknown>,
		];
		const [, inputs] = lastCall;
		const messages = inputs.messages as Array<Record<string, unknown>>;
		expect(messages[0].role).toBe("system");
		expect(String(messages[0].content)).toContain("El contexto relevante");
	});
});

describe("misc", () => {
	it("returns 404 for unknown paths", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(env, "https://example.com/other", {
			headers: authHeaders(),
		});
		expect(response.status).toBe(404);
	});

	it("handles CORS preflight", async () => {
		const env = makeEnv({ run: vi.fn() });
		const response = await fetchWith(env, "https://example.com/engines/v1/models", {
			method: "OPTIONS",
		});
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
	});
});