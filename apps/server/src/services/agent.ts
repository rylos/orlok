import type { TokenUsage } from "@orlok/shared";
import type { LlmClient, LlmMessage, ToolCall, ToolDefinition, ToolResult } from "../llm";
import { trimMiddle } from "./context";

// A tool the model can call. run() returns the text given back to the model; throwing
// ToolInputError reports a problem the model can fix (bad input, conflict) instead of failing.
export type AgentTool = ToolDefinition & {
  run(input: unknown): Promise<string>;
};

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; isError: boolean }
  | { type: "done"; text: string; usage: TokenUsage | null; stopReason: string | null };

type RunAgentOptions = {
  client: LlmClient;
  model: string;
  maxOutputTokens: number;
  system: string;
  messages: LlmMessage[];
  tools: AgentTool[];
  signal?: AbortSignal;
  // Model calls in one run; the run stops when the model still wants tools after the last one.
  maxSteps?: number;
  // A single command can print more than the model can read. Results longer than this keep their
  // beginning and their end, so one noisy tool cannot fill the window mid-answer.
  toolResultMaxChars?: number;
};

function addUsage(total: TokenUsage | null, usage: TokenUsage | null): TokenUsage | null {
  if (!usage) {
    return total;
  }
  return total
    ? {
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
      }
    : usage;
}

// Tool loop: call the model, run the tools it asks for, send the results back, repeat until it
// answers without tools. Text from every step is streamed and joined into the final answer.
export async function* runAgent({
  client,
  model,
  maxOutputTokens,
  system,
  messages: initialMessages,
  tools,
  signal,
  maxSteps = 10,
  toolResultMaxChars,
}: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const messages = [...initialMessages];
  let text = "";
  let usage: TokenUsage | null = null;
  let stopReason: string | null = null;

  for (let step = 0; step < maxSteps; step++) {
    let stepText = "";
    let calls: ToolCall[] = [];
    let providerData: unknown;

    for await (const chunk of client.streamChat({
      model,
      maxOutputTokens,
      system,
      messages,
      tools,
      signal,
    })) {
      if (chunk.type === "text") {
        // Keep the text of consecutive steps apart.
        if (!stepText && text && !text.endsWith("\n")) {
          text += "\n\n";
          yield { type: "text", text: "\n\n" };
        }
        stepText += chunk.text;
        text += chunk.text;
        yield chunk;
      } else if (chunk.type === "tool_start") {
        yield chunk;
      } else if (chunk.type === "tool_calls") {
        calls = chunk.calls;
        providerData = chunk.providerData;
      } else {
        stopReason = chunk.stopReason;
        usage = addUsage(usage, chunk.usage);
      }
    }

    if (calls.length === 0) {
      break;
    }

    messages.push({ role: "assistant", content: stepText, toolCalls: calls, providerData });
    const results: ToolResult[] = [];
    for (const call of calls) {
      yield { type: "tool_call", call };
      const tool = tools.find((item) => item.name === call.name);
      let content: string;
      let isError = false;
      if (!tool) {
        content = `Unknown tool "${call.name}".`;
        isError = true;
      } else {
        try {
          content = await tool.run(call.input);
        } catch (error) {
          if (!(error instanceof ToolInputError)) {
            throw error;
          }
          content = error.message;
          isError = true;
        }
      }
      results.push({
        toolCallId: call.id,
        content: toolResultMaxChars ? trimMiddle(content, toolResultMaxChars) : content,
        isError,
      });
      yield { type: "tool_result", call, isError };
    }
    messages.push({ role: "tool", results });
    stopReason = "max_steps";
  }

  yield { type: "done", text, usage, stopReason };
}
