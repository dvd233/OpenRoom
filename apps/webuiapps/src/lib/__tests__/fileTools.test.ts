import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeFileTool, getFileToolDefinitions, isFileTool } from '../fileTools';
import { setSessionPath } from '../sessionPath';

// Keep the real diskStorage implementation: mocking it would hide the regression.
const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('Unexpected fetch'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.clear();
  setSessionPath('');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setSessionPath('');
});

describe.each(['file_write', 'file_delete'])('%s real storage path', (tool) => {
  const params = { file_path: '/apps/diary/data/note.json', content: '{"note":"synthetic"}' };
  const operation = tool === 'file_write' ? 'write' : 'delete';

  it.each([403, 500])(
    'reports HTTP %i as an error without exposing response content',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('private diagnostic body', { status }));
      expect(await executeFileTool(tool, params)).toBe(
        `error: Error: File ${operation} failed: HTTP ${status}`,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([new Error('Synthetic offline'), 'synthetic rejection'])(
    'reports network failure',
    async (error) => {
      fetchMock.mockRejectedValue(error);
      expect(await executeFileTool(tool, params)).toBe(`error: ${String(error)}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 204])(
    'preserves success for HTTP %i and scoped request identity',
    async (status) => {
      setSessionPath('synthetic-character/synthetic-mod');
      fetchMock.mockResolvedValue(new Response(null, { status }));
      expect(await executeFileTool(tool, params)).toBe('success');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/session-data?path=synthetic-character%2Fsynthetic-mod%2Fapps%2Fdiary%2Fdata%2Fnote.json',
        tool === 'file_write'
          ? { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: params.content }
          : { method: 'DELETE' },
      );
    },
  );

  it('rejects an empty path without making a request', async () => {
    expect(await executeFileTool(tool, { file_path: '/', content: '' })).toBe(
      'error: file_path is required',
    );
    expect(await executeFileTool(tool, {})).toBe('error: file_path is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('unchanged validation and tool contracts', () => {
  it('keeps the public tools and required arguments unchanged', () => {
    expect(
      getFileToolDefinitions().map(({ function: fn }) => [fn.name, fn.parameters.required]),
    ).toEqual([
      ['file_read', ['file_path']],
      ['file_write', ['file_path', 'content']],
      ['file_list', ['directory']],
      ['file_delete', ['file_path']],
    ]);
    for (const name of ['file_read', 'file_write', 'file_list', 'file_delete'])
      expect(isFileTool(name)).toBe(true);
    expect(isFileTool('unknown')).toBe(false);
  });

  it('writes empty plain text but rejects missing content', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await executeFileTool('file_write', { file_path: 'note.txt', content: '' })).toBe(
      'success',
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/session-data?path=apps%2Fnote.txt', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '',
    });
    fetchMock.mockClear();
    expect(await executeFileTool('file_write', { file_path: 'note.txt' })).toBe(
      'error: content is required',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [' {"a":1} ', '{"a":1}'],
    ['```json\n{"a":1}\n```', '{"a":1}'],
    [
      'Here is JSON: {"a":{"braces":"} and \\"quote\\""}} done',
      '{"a":{"braces":"} and \\"quote\\""}}',
    ],
    ['Values: [1,{"a":2},[3]] done', '[1,{"a":2},[3]]'],
  ])('preserves valid JSON extraction', async (content, expected) => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await executeFileTool('file_write', { file_path: 'note.json', content })).toBe(
      'success',
    );
    expect(fetchMock.mock.calls[0][1]?.body).toBe(expected);
  });

  it.each(['not JSON', '```json\n{oops}\n```', '{"unfinished":', 'prefix [invalid] suffix'])(
    'rejects invalid JSON before storage',
    async (content) => {
      expect(await executeFileTool('file_write', { file_path: 'note.json', content })).toMatch(
        /^error: invalid JSON/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('preserves text and JSON reads and missing-file results', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('text'))
      .mockResolvedValueOnce(new Response('{"a":1}'))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await executeFileTool('file_read', { file_path: '/note.txt' })).toBe('text');
    expect(await executeFileTool('file_read', { file_path: 'note.json' })).toBe('{\n  "a": 1\n}');
    expect(await executeFileTool('file_read', { file_path: 'missing' })).toBe(
      'error: file not found',
    );
    expect(await executeFileTool('file_read', {})).toBe('error: file_path is required');
  });

  it('preserves empty and populated directory listing output', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"files":[]}')).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          files: [
            { path: 'apps/notes', type: 1 },
            { path: 'apps/note.txt', type: 0 },
            { path: '', type: 0 },
          ],
        }),
      ),
    );
    expect(await executeFileTool('file_list', {})).toBe('empty directory');
    expect(await executeFileTool('file_list', { directory: '/apps/' })).toBe(
      '[dir]  notes\n[file] note.txt\n[file] ',
    );
  });

  it('preserves error formatting for malformed listings and unknown tools', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    expect(await executeFileTool('file_list', { directory: '/' })).toMatch(/^error:/);
    expect(await executeFileTool('unknown', {})).toBe('error: unknown file tool unknown');
  });
});
