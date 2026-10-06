import { test, expect } from '@playwright/test';

interface ModelRequest {
  messages: Array<{ role: string; content: string; tool_call_id?: string }>;
  tools: Array<{ function: { name: string } }>;
}

for (const tool of ['file_write', 'file_delete']) {
  for (const outcome of ['http-500', 'network-error', 'http-200', 'http-204']) {
    test(`${tool} forwards ${outcome} to the next model request`, async ({ page, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      const llm = {
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'synthetic-model',
      };
      const session = 'test-character/test-mod';
      const filePath = 'apps/diary/data/entries/synthetic-entry.json';
      const scopedPath = `${session}/${filePath}`;
      const content = '{"id":"synthetic-entry","content":"Synthetic test only"}';
      const toolCallId = 'synthetic-file-operation';
      const finalMessage = 'Synthetic tool result received.';
      const modelRequests: ModelRequest[] = [];
      const mutationRequests: Array<{ method: string; path: string; body: string | null }> = [];
      const files = new Map<string, string>();
      const unexpectedApiRequests: string[] = [];

      await page.addInitScript(
        ({ llm }) => {
          localStorage.clear();
          localStorage.setItem('webuiapps-llm-config', JSON.stringify(llm));
          localStorage.setItem(
            'openroom_characters',
            JSON.stringify({
              activeId: 'test-character',
              items: {
                'test-character': {
                  id: 'test-character',
                  character_name: 'Test character',
                  character_gender_desc: '',
                  character_desc: 'Synthetic test character.',
                  character_emotion_list: [],
                },
              },
            }),
          );
          localStorage.setItem(
            'openroom_mods',
            JSON.stringify({
              activeId: 'test-mod',
              items: {
                'test-mod': {
                  config: {
                    id: 'test-mod',
                    mod_name: 'Test mod',
                    mod_name_en: 'Test mod',
                    mod_description: 'Synthetic test scenario.',
                    stage_count: 1,
                    prologue: 'Synthetic session ready.',
                    stages: {
                      0: {
                        stage_index: 0,
                        stage_name: 'Test',
                        stage_description: '',
                        stage_targets: {},
                      },
                    },
                  },
                  state: {
                    current_stage_index: 0,
                    total_stage_count: 1,
                    is_finished: false,
                    completed_targets: [],
                  },
                },
              },
            }),
          );
        },
        { llm },
      );

      // All app API traffic is synthetic. External assets/providers are blocked;
      // only local static assets and the Vite module graph reach the dev server.
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort('blockedbyclient');
        if (url.pathname === '/api/llm-config') return route.fulfill({ json: { llm } });
        if (url.pathname === '/api/characters' || url.pathname === '/api/mods') {
          return route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname === '/api/log') return route.fulfill({ json: { ok: true } });
        if (url.pathname === '/api/llm-proxy') {
          modelRequests.push(request.postDataJSON() as ModelRequest);
          if (modelRequests.length === 1) {
            return route.fulfill({
              json: {
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: '',
                      tool_calls: [
                        {
                          id: toolCallId,
                          type: 'function',
                          function: {
                            name: tool,
                            arguments: JSON.stringify(
                              tool === 'file_write'
                                ? { file_path: filePath, content }
                                : { file_path: filePath },
                            ),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            });
          }
          return route.fulfill({
            json: { choices: [{ message: { role: 'assistant', content: finalMessage } }] },
          });
        }
        if (url.pathname === '/api/session-data') {
          const path = url.searchParams.get('path') || '';
          if (
            path === scopedPath &&
            request.method() === (tool === 'file_write' ? 'POST' : 'DELETE')
          ) {
            mutationRequests.push({ method: request.method(), path, body: request.postData() });
            if (outcome === 'network-error') return route.abort('failed');
            if (outcome === 'http-500')
              return route.fulfill({ status: 500, body: 'private diagnostic body' });
            return route.fulfill({ status: outcome === 'http-204' ? 204 : 200, body: '' });
          }
          if (request.method() === 'POST') {
            files.set(path, request.postData() || '');
            return route.fulfill({ json: { ok: true } });
          }
          if (url.searchParams.get('action') === 'list')
            return route.fulfill({ json: { files: [], not_exists: false } });
          if (files.has(path)) return route.fulfill({ body: files.get(path)! });
          return route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname.startsWith('/api/')) {
          unexpectedApiRequests.push(`${request.method()} ${url.pathname}`);
          return route.fulfill({ status: 501, body: 'Unexpected synthetic API request' });
        }
        return route.continue();
      });

      await page.goto('/');
      await expect(page.getByTestId('chat-messages')).toContainText('Synthetic session ready.');
      await page.getByTestId('chat-input').fill('Perform the synthetic file operation.');
      await page.getByTestId('send-btn').click();
      await expect(page.getByTestId('chat-messages')).toContainText(finalMessage);

      expect(modelRequests).toHaveLength(2);
      expect(modelRequests[0].tools.some(({ function: fn }) => fn.name === tool)).toBe(true);
      const results = modelRequests[1].messages.filter(
        (message) => message.tool_call_id === toolCallId,
      );
      expect(results).toHaveLength(1);
      expect(results[0].role).toBe('tool');
      if (outcome === 'http-500') {
        expect(results[0].content).toBe(
          `error: Error: File ${tool === 'file_write' ? 'write' : 'delete'} failed: HTTP 500`,
        );
      } else if (outcome === 'network-error') {
        expect(results[0].content).toMatch(/^error:/);
      } else {
        expect(results[0].content).toBe('success');
      }
      expect(results[0].content).not.toContain('private diagnostic body');
      expect(mutationRequests).toEqual([
        {
          method: tool === 'file_write' ? 'POST' : 'DELETE',
          path: scopedPath,
          body: tool === 'file_write' ? content : null,
        },
      ]);
      expect(unexpectedApiRequests).toEqual([]);
    });
  }
}
