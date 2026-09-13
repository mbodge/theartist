import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { discoverySchema, isFounder, StudioError, type AgentRequest, type AgentResponse } from './domain.js';
import { boardInstructions } from './board.js';
import { founderInstructions } from './founder.js';

function publicUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || value.length > 4000) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Preserve hosted-tool metadata and citation context, never internal reasoning items. */
export function discoveryRecord(response: OpenAI.Responses.Response, limit: number) {
  if (response.status !== 'completed') throw new StudioError('Web discovery did not complete');
  const calls = response.output.filter(item => item.type === 'web_search_call');
  if (!calls.some(call => call.status === 'completed')) throw new StudioError('Discovery requires a completed web tool call');
  if (calls.length > limit) throw new StudioError('Discovery exceeded its web tool allowance');
  const toolCalls = calls.map(call => {
    const action = call.action;
    const candidates = action.type === 'search' ? (action.sources ?? []).map(source => source.url) : [action.url ?? ''];
    return { id: call.id, status: call.status, action: action.type,
      queries: action.type === 'search' ? (action.queries ?? (action.query ? [action.query] : [])).slice(0, 20).map(q => q.slice(0, 4000)) : [],
      urls: candidates.map(publicUrl).filter((url): url is string => url !== null).slice(0, 100) };
  });
  const sources = new Map<string, { id: string; url: string; title: string; summary: string }>();
  const texts: string[] = [];
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type !== 'output_text') continue;
      texts.push(part.text);
      let previousCitationEnd = 0;
      const citations = part.annotations.filter(citation => citation.type === 'url_citation')
        .sort((a, b) => a.start_index - b.start_index);
      for (const citation of citations) {
        const url = publicUrl(citation.url);
        const end = citation.start_index;
        const paragraphStart = part.text.lastIndexOf('\n\n', Math.max(0, end - 1)) + 2;
        const context = Number.isInteger(end) && end > 0 && end <= part.text.length
          ? part.text.slice(Math.max(0, end - 1200, paragraphStart > 1 ? paragraphStart : 0, previousCitationEnd), end).trim()
          : 'Source cited in the discovery report; refer to the report for its context.';
        if (Number.isInteger(citation.end_index) && citation.end_index >= end && citation.end_index <= part.text.length) previousCitationEnd = citation.end_index;
        if (!url || sources.has(url) || sources.size >= 8) continue;
        sources.set(url, { id: `web-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`,
          url, title: (citation.title || url).slice(0, 300), summary: context || 'Source cited in discovery report.' });
      }
    }
  }
  return discoverySchema.parse({ report: texts.join('\n\n'), sources: [...sources.values()], toolCalls });
}

export async function discover(client: OpenAI, model: string, request: AgentRequest,
  signal: AbortSignal, input: unknown): Promise<AgentResponse> {
  const limit = request.cycle.policy.maxWebCallsPerAttempt ?? 0;
  if (!isFounder(request.cycle.profile) || limit < 1) throw new StudioError('Web discovery is disabled for this cycle');
  // API-documented field; SDK 7.15 exposes it on ResponseCreate but omits it on this REST params type.
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming & { max_tool_calls: number } = {
    model, instructions: `${founderInstructions.discover}\n${boardInstructions}\nYou have at most ${limit} web tool calls, including searches and page reads. Today is ${new Date().toISOString().slice(0, 10)}.`,
    input: JSON.stringify(input),
    tools: [{ type: 'web_search', search_context_size: 'medium', external_web_access: true }],
    tool_choice: 'required', max_tool_calls: limit,
    include: ['web_search_call.action.sources'],
    max_output_tokens: request.cycle.policy.maxOutputTokens, store: false,
  };
  const response = await client.responses.create(params, { signal, timeout: request.cycle.policy.callTimeoutMs, maxRetries: 0 });
  return { output: discoveryRecord(response, limit), inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null, responseId: response.id };
}
