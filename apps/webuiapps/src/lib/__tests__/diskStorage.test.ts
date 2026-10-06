import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteFilesByPaths,
  getFile,
  listFiles,
  putBinaryFile,
  putTextFilesByJSON,
  searchFiles,
} from '../diskStorage';
import { setSessionPath } from '../sessionPath';

const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('Unexpected fetch'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setSessionPath('');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setSessionPath('');
});

const mutations = [
  {
    name: 'write',
    run: (throwOnError?: boolean) =>
      putTextFilesByJSON({ files: [{ name: 'note.txt', content: 'hello' }], throwOnError }),
  },
  {
    name: 'delete',
    run: (throwOnError?: boolean) => deleteFilesByPaths({ file_paths: ['note.txt'], throwOnError }),
  },
];

describe.each(mutations)('$name failures', ({ name, run }) => {
  it.each([403, 500])(
    'rejects HTTP %i when requested without reading response data',
    async (status) => {
      const text = vi.fn().mockRejectedValue(new Error('Private response body'));
      fetchMock.mockResolvedValue({ ok: false, status, text } as unknown as Response);

      await expect(run(true)).rejects.toThrow(`File ${name} failed: HTTP ${status}`);
      expect(text).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false])(
    'preserves best-effort HTTP behavior with option %s',
    async (option) => {
      fetchMock.mockResolvedValue(new Response('Private response body', { status: 500 }));
      await expect(run(option)).resolves.toBeUndefined();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false])(
    'preserves best-effort network behavior with option %s',
    async (option) => {
      const error = new Error('Synthetic offline');
      fetchMock.mockRejectedValue(error);
      await expect(run(option)).resolves.toBeUndefined();
      if (name === 'write') {
        expect(console.warn).toHaveBeenCalledWith(
          '[diskStorage] putTextFilesByJSON write failed:',
          error,
        );
      } else {
        expect(console.warn).not.toHaveBeenCalled();
      }
    },
  );

  it.each([new Error('Synthetic offline'), 'synthetic rejection'])(
    'preserves rejection identity',
    async (error) => {
      fetchMock.mockRejectedValue(error);
      await expect(run(true)).rejects.toBe(error);
      expect(console.warn).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 204])('accepts HTTP %i without consuming a body', async (status) => {
    const text = vi.fn().mockRejectedValue(new Error('Must not read'));
    const json = vi.fn().mockRejectedValue(new Error('Must not parse'));
    fetchMock.mockResolvedValue({ ok: true, status, text, json } as unknown as Response);
    await expect(run(true)).resolves.toBeUndefined();
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

describe('mutation requests and batches', () => {
  it('preserves empty batches and skipped unnamed writes', async () => {
    await putTextFilesByJSON({ files: [], throwOnError: true });
    await putTextFilesByJSON({ files: [{}], throwOnError: true });
    await deleteFilesByPaths({ file_paths: [], throwOnError: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the file content and existing headers, preserving session paths', async () => {
    setSessionPath('character/mod');
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await putTextFilesByJSON({
      files: [{ path: '/apps/diary', name: 'note.txt', content: '' }, { name: 'empty.txt' }],
      throwOnError: true,
    });
    expect(fetchMock.mock.calls).toEqual([
      [
        '/api/session-data?path=character%2Fmod%2Fapps%2Fdiary%2Fnote.txt',
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '',
        },
      ],
      [
        '/api/session-data?path=character%2Fmod%2Fapps%2Fempty.txt',
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '',
        },
      ],
    ]);
    await deleteFilesByPaths({ file_paths: ['/apps/diary/note.txt'], throwOnError: true });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/session-data?path=character%2Fmod%2Fapps%2Fdiary%2Fnote.txt',
      { method: 'DELETE' },
    );
  });

  it.each(['write', 'delete'])(
    '%s batch rejects before other requests settle',
    async (operation) => {
      let finishSibling!: (response: Response) => void;
      const sibling = new Promise<Response>((resolve) => {
        finishSibling = resolve;
      });
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockReturnValueOnce(sibling);
      const batch =
        operation === 'write'
          ? putTextFilesByJSON({
              files: [{ name: 'failed.txt' }, { name: 'saved.txt' }],
              throwOnError: true,
            })
          : deleteFilesByPaths({ file_paths: ['failed.txt', 'saved.txt'], throwOnError: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const outcome = await Promise.race([
        batch.then(
          () => ({ kind: 'success' }),
          (error: unknown) => ({ kind: 'error', error }),
        ),
        new Promise<{ kind: string }>((resolve) => {
          setTimeout(() => resolve({ kind: 'pending' }), 0);
        }),
      ]);
      finishSibling(new Response(null, { status: 204 }));
      await batch.catch(() => {});
      expect(outcome).toEqual({
        kind: 'error',
        error: new Error(`File ${operation} failed: HTTP 500`),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['write', 'delete'])(
    'best-effort %s batch waits for remaining requests',
    async (operation) => {
      let finishSibling!: (response: Response) => void;
      const sibling = new Promise<Response>((resolve) => {
        finishSibling = resolve;
      });
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockReturnValueOnce(sibling);
      const batch =
        operation === 'write'
          ? putTextFilesByJSON({ files: [{ name: 'failed.txt' }, { name: 'saved.txt' }] })
          : deleteFilesByPaths({ file_paths: ['failed.txt', 'saved.txt'] });
      let settled = false;
      const completed = batch.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);
      finishSibling(new Response(null, { status: 204 }));
      await completed;
      expect(settled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});

describe('unchanged read, list, search and binary behavior', () => {
  it('lists an already-prefixed root without adding apps twice', async () => {
    const result = { files: [], not_exists: false };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(result)));
    expect(await listFiles('apps')).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/session-data?path=apps&action=list');
  });

  it('retains not-found results for HTTP and network listing errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await listFiles('/')).toEqual({ files: [], not_exists: true });
    expect(await listFiles('/')).toEqual({ files: [], not_exists: true });
  });

  it('reads JSON and plain text without changing their representation', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"value":1}'))
      .mockResolvedValueOnce(new Response('text'));
    expect(await getFile('apps/value.json')).toEqual({ value: 1 });
    expect(await getFile('note.txt')).toBe('text');
  });

  it('retains null for HTTP and network read errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await getFile('missing')).toBeNull();
    expect(await getFile('missing')).toBeNull();
  });

  it('searches file and directory names case-insensitively', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            { path: 'apps/Note.txt', type: 0, size: 2 },
            { path: 'apps/notes', type: 1 },
            { path: 'apps/other.txt', type: 0 },
          ],
        }),
      ),
    );
    expect(await searchFiles({ query: 'NOTE' })).toEqual([
      {
        id: '',
        name: 'Note.txt',
        path: '/apps/Note.txt',
        type: 'file',
        parentId: null,
        metadata: { size: 2 },
      },
      {
        id: '',
        name: 'notes',
        path: '/apps/notes',
        type: 'directory',
        parentId: null,
        metadata: { size: 0 },
      },
    ]);
  });

  it('retains an empty search result for malformed listings', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    expect(await searchFiles({ query: 'note' })).toEqual([]);
  });

  it('preserves binary request data', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await putBinaryFile('image.bin', 'AQID', 'application/octet-stream');
    expect(fetchMock).toHaveBeenCalledWith('/api/session-data?path=apps%2Fimage.bin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
  });
});
