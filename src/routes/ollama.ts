/*
 * File: ollama.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-22
 */

import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { app } from '../index.ts';
import type { QwenModel } from '../services/qwen.ts';
import { fetchQwenModels, getModel } from '../services/qwen.ts';

export async function listModels(c: Context) {
  try {
    const models = await fetchQwenModels();
    return c.json({
      models: models.map((m: QwenModel) => ({
        name: m.id,
        model: m.id,
        modified_at: new Date(m.created * 1000).toISOString(),
        size: 0,
        digest: m.id.replace(/[^a-z0-9]/gi, ''),
        details: {
          format: 'gguf',
          family: 'qwen',
          families: ['qwen'],
          parameter_size: '0B',
          quantization_level: 'Q4_0',
        },
      })),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export async function showModel(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const model = getModel(body.model);
  const modelName = model?.name || 'qwen-max';

  return c.json({
    template: '{{ .System }}\n{{ .Prompt }}',
    capabilities: ['tools', 'vision'],
    details: {
      family: 'qwen',
      families: ['qwen'],
      format: 'gguf',
      parameter_size: '0B',
      quantization_level: 'Q4_0',
    },
    model_info: {
      'general.basename': modelName,
      'general.architecture': 'qwen',
      'qwen.context_length': model?.max_context_length || 131072,
    },
  });
}

export async function getVersion(c: Context) {
  return c.json({ version: '0.6.4' });
}

/**
 * Ollama Chat compatibility route.
 * Reuses the OpenAI route logic by making an internal fetch call.
 */
export async function ollamaChat(c: Context) {
  const body = await c.req.json();
  const stream = body.stream ?? true;

  // Translate Ollama options to OpenAI
  const openaiBody = {
    model: body.model,
    messages: body.messages,
    stream: true, // Internal calls always use stream for unified handling
    temperature: body.options?.temperature,
    top_p: body.options?.top_p,
  };

  // Internal fetch call to our own OpenAI route
  const response = await app.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Pass the original API key if present
        Authorization: c.req.header('Authorization') || '',
      },
      body: JSON.stringify(openaiBody),
    }),
  );

  if (!response.ok) {
    return c.json(
      await response.json().catch(() => ({ error: 'Internal Error' })),
      response.status as ContentfulStatusCode,
    );
  }

  if (!stream) {
    // Non-streaming response: wait for all chunks and return one Ollama object
    const text = await response.text();
    let fullContent = '';
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') continue;
        try {
          const chunk = JSON.parse(dataStr);
          fullContent += chunk.choices[0].delta?.content || '';
        } catch {}
      }
    }
    return c.json({
      model: body.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: fullContent },
      done: true,
    });
  }

  // Streaming response
  return honoStream(c, async (streamWriter) => {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            const final = {
              model: body.model,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: '' },
              done: true,
            };
            await streamWriter.write(
              new TextEncoder().encode(`${JSON.stringify(final)}\n`),
            );
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);
            const delta = chunk.choices[0].delta?.content || '';
            const reasoning = chunk.choices[0].delta?.reasoning_content || '';

            // Ollama doesn't have a standard 'reasoning_content' field in the same way,
            // but we can prepend it or just send it as content if needed.
            // For VS Code Copilot, content is usually enough.
            const content = reasoning
              ? `<think>\n${reasoning}\n</think>\n`
              : delta;

            if (content) {
              const ollamaChunk = {
                model: body.model,
                created_at: new Date().toISOString(),
                message: { role: 'assistant', content },
                done: false,
              };
              await streamWriter.write(
                new TextEncoder().encode(`${JSON.stringify(ollamaChunk)}\n`),
              );
            }
          } catch {}
        }
      }
    } catch (err) {
      console.error(
        '[Ollama Proxy] Stream error:',
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}
