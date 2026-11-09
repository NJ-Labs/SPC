import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

type TestWorker = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

async function parseWorkbook(bytes: ArrayBuffer, fileName: string, maxRowsPerSheet = 100) {
  const worker: TestWorker = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  vi.resetModules();
  await import('./excelParser.worker');
  if (!worker.onmessage) throw new Error('The real workbook worker did not register its handler');
  worker.onmessage(new MessageEvent('message', { data: { data: bytes, fileName, maxRowsPerSheet } }));
  return worker.postMessage.mock.calls.map(([message]) => message);
}

function workbookBytes(bookType: 'xls' | 'xlsx' | 'xlsm'): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Measurement', 'Pass', 'הערה'],
    [1.25, false, null],
    [-2.5, true, 'דוגמה'],
    [0, false, 'zero'],
  ]), 'Samples');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Batch', 'Count'], ['B1', 3],
  ]), 'Batches');
  return XLSX.write(workbook, { type: 'array', bookType });
}

afterEach(() => vi.unstubAllGlobals());

describe('patched SheetJS integration with the real Excel worker', () => {
  it.each(['xls', 'xlsx', 'xlsm'] as const)('preserves subgroup observations and sheets from %s files', async bookType => {
    const messages = await parseWorkbook(workbookBytes(bookType), `samples.${bookType}`);
    const response = messages.find(message => message.type === 'done');
    expect(response?.ok).toBe(true);
    expect(response.payload.fileType).toBe(bookType);
    expect(response.payload.sheets).toEqual([
      { name: 'Samples', headers: ['Measurement', 'Pass', 'הערה'], data: [
        { Measurement: 1.25, Pass: false, 'הערה': null },
        { Measurement: -2.5, Pass: true, 'הערה': 'דוגמה' },
        { Measurement: 0, Pass: false, 'הערה': 'zero' },
      ] },
      { name: 'Batches', headers: ['Batch', 'Count'], data: [{ Batch: 'B1', Count: 3 }] },
    ]);
  });

  it('keeps row limits and progress messages with the new dense worksheet format', async () => {
    const messages = await parseWorkbook(workbookBytes('xlsx'), 'samples.xlsx', 2);
    expect(messages.some(message => message.type === 'progress' && message.message.includes('Opening'))).toBe(true);
    const response = messages.find(message => message.type === 'done');
    expect(response?.ok).toBe(true);
    expect(response.payload.sheets[0].data).toHaveLength(2);
    expect(response.payload.sheets[1].data).toHaveLength(1);
  });

  it('returns a worker error for a corrupted ZIP workbook', async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 0, 0, 0]).buffer;
    const messages = await parseWorkbook(bytes, 'corrupt.xlsx');
    expect(messages.find(message => message.type === 'error')).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
