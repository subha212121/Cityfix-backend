import OpenAI, { AzureOpenAI } from 'openai';
import { config } from '../config.js';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface JsonResult {
  data: unknown;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}
export interface AiProvider {
  name: 'openai' | 'azure' | 'gemini';
  model: string;
  json(messages: ChatTurn[], timeoutMs: number): Promise<JsonResult>;
}

/**
 * One adapter for all three providers the brief allows. Azure OpenAI and
 * Google Gemini both speak the OpenAI chat-completions protocol (Gemini through
 * its OpenAI-compatible endpoint), so the same call works for each.
 */
function build(): AiProvider | null {
  let client: OpenAI;
  let model = config.AI_MODEL;
  switch (config.AI_PROVIDER) {
    case 'openai':
      if (!config.OPENAI_API_KEY) return null;
      client = new OpenAI({ apiKey: config.OPENAI_API_KEY, maxRetries: 1 });
      break;
    case 'azure':
      if (!config.AZURE_OPENAI_API_KEY || !config.AZURE_OPENAI_ENDPOINT || !config.AZURE_OPENAI_DEPLOYMENT) return null;
      client = new AzureOpenAI({
        apiKey: config.AZURE_OPENAI_API_KEY,
        endpoint: config.AZURE_OPENAI_ENDPOINT,
        deployment: config.AZURE_OPENAI_DEPLOYMENT,
        apiVersion: config.AZURE_OPENAI_API_VERSION,
        maxRetries: 1,
      });
      model = config.AZURE_OPENAI_DEPLOYMENT;
      break;
    case 'gemini':
      if (!config.GEMINI_API_KEY) return null;
      client = new OpenAI({
        apiKey: config.GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        maxRetries: 1,
      });
      break;
    default:
      return null;
  }

  return {
    name: config.AI_PROVIDER as AiProvider['name'],
    model,
    async json(messages, timeoutMs) {
      const res = await client.chat.completions.create(
        { model, messages, temperature: 0.1, response_format: { type: 'json_object' } },
        { timeout: timeoutMs },
      );
      const text = res.choices[0]?.message?.content ?? '{}';
      return {
        data: JSON.parse(text),
        model: res.model ?? model,
        tokensIn: res.usage?.prompt_tokens,
        tokensOut: res.usage?.completion_tokens,
      };
    },
  };
}

let provider: AiProvider | null | undefined;
export function getProvider(): AiProvider | null {
  if (provider === undefined) provider = build();
  return provider;
}
/** Tests swap in a fake provider. */
export function setProvider(p: AiProvider | null) {
  provider = p;
}

/** Strip emails and phone numbers before text leaves the council's systems. */
export const redact = (text: string) =>
  text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(\+?61|0)[\s-]?[2-9](?:[\s-]?\d){8}/g, '[phone]');
