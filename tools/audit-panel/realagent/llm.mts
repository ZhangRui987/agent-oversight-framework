/**
 * llm.mts —— OpenAI 兼容 chat/completions 客户端（零依赖：Node 22 内置 fetch）
 *
 * 用途：V2 real-agent 的唯一 LLM 通道。设计约束（与 V2 规划 §2 对应）：
 *   - key 只从环境变量 `OVERSIGHT_LLM_API_KEY` 读取；缺失时 fail-loud 退出，
 *     不降级、不模拟、不打印任何 key 片段到日志或错误信息。
 *   - key 绝不出现在本文件任何字面量、任何异常文本、任何日志输出中。
 *   - 每次调用的 token 用量必须返回（成本透明，规划 §8）。
 *
 * 兼容：任何 OpenAI chat/completions 协议厂商（默认 DeepSeek）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息携带的工具调用请求（OpenAI tool_calls 形态，原样透传）。 */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** role=tool 消息的工具结果标识。 */
  tool_call_id?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string | null;
  toolCalls: NonNullable<ChatMessage['tool_calls']>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
  rawAssistant: ChatMessage;
}

/** key 解析：环境变量优先；兜底读 tools/audit-panel/.env（该文件不入 git）。 */
function resolveApiKey(): string {
  const fromEnv = process.env.OVERSIGHT_LLM_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    // 兜底：本地 .env（格式：OVERSIGHT_LLM_API_KEY=sk-...）。路径相对本文件，与工作目录无关。
    const envFile = fileURLToPath(new URL('../.env', import.meta.url));
    const text = readFileSync(envFile, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*OVERSIGHT_LLM_API_KEY\s*=\s*(\S+)\s*$/);
      if (m) return m[1]!;
    }
  } catch {
    /* .env 不存在则视为无 key，走 fail-loud */
  }
  throw new Error(
    '未找到 OVERSIGHT_LLM_API_KEY：请设置环境变量，或在 tools/audit-panel/.env 中写入一行 ' +
      '"OVERSIGHT_LLM_API_KEY=<key>"（该文件已被 .gitignore 排除，不会入库）。' +
      'V2 设计为 fail-loud：无 key 不模拟、不降级。',
  );
}

export function resolveLlmConfig(): { baseUrl: string; model: string } {
  return {
    baseUrl: (process.env.OVERSIGHT_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: process.env.OVERSIGHT_LLM_MODEL ?? DEFAULT_MODEL,
  };
}

/** 单轮 chat 调用。不重试（重试会让行为数据失真——失败本身也是可审计事件）。 */
export async function chat(
  messages: ChatMessage[],
  tools: ToolSchema[],
): Promise<ChatResult> {
  const key = resolveApiKey();
  const { baseUrl, model } = resolveLlmConfig();

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    // 错误体可能回显请求片段——只保留状态码，不透传 body（防止 key 相关内容泄漏）。
    throw new Error(`LLM API 调用失败：HTTP ${resp.status}（详情不透传，见 provider 控制台）`);
  }

  const j = (await resp.json()) as {
    choices: Array<{
      message: ChatMessage;
      finish_reason: string;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const choice = j.choices[0];
  if (!choice) throw new Error('LLM API 返回空 choices');

  return {
    content: choice.message.content ?? null,
    toolCalls: choice.message.tool_calls ?? [],
    usage: {
      promptTokens: j.usage?.prompt_tokens ?? 0,
      completionTokens: j.usage?.completion_tokens ?? 0,
      totalTokens: j.usage?.total_tokens ?? 0,
    },
    finishReason: choice.finish_reason,
    rawAssistant: choice.message,
  };
}
