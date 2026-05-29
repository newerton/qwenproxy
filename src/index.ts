/*
 * File: index.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { networkInterfaces } from 'node:os';
import { serve } from '@hono/node-server';
import * as dotenv from 'dotenv';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import {
  getVersion,
  listModels,
  ollamaChat,
  showModel,
} from './routes/ollama.ts';
import { type BrowserType, initPlaywright } from './services/playwright.ts';
import { fetchQwenModels } from './services/qwen.ts';

dotenv.config();

export const app = new Hono();

app.use('*', cors());

// Helper to get local network IPs
function getNetworkAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// API Key protection middleware
app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return await next();
  }
  return bearerAuth({ token: apiKey })(c, next);
});

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

// Ollama compatible routes
app.get('/api/tags', listModels);
app.get('/api/list', listModels);
app.post('/api/show', showModel);
app.get('/api/version', getVersion);
app.post('/api/chat', ollamaChat);

app.get('/v1/models', async (c) => {
  try {
    const models = await fetchQwenModels();
    return c.json({
      object: 'list',
      data: models,
    });
  } catch (err) {
    return c.json(
      { error: { message: err instanceof Error ? err.message : String(err) } },
      500,
    );
  }
});

// Initialize playwright when server starts
import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Parse browser type from args or env
  let browserType: BrowserType = 'chromium';
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType;
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType;
  }

  initPlaywright(true, browserType)
    .then(() => {
      console.log(`Playwright initialized (${browserType}).`);
      const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 11434;

      const networkIP = getNetworkAddress();

      console.log('\n🚀 QwenProxy started!');
      console.log(`- Local:   http://localhost:${port}`);
      if (networkIP) {
        console.log(`- Network: http://${networkIP}:${port}`);
      }

      console.log('\nAvailable Routes:');
      app.routes.forEach((route) => {
        console.log(`- [${route.method}] ${route.path}`);
      });
      console.log('');

      serve({
        fetch: app.fetch,
        port,
      });
    })
    .catch((err) => {
      console.error(
        'Failed to initialize playwright:',
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    });
}
