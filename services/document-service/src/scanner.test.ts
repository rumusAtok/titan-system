import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clamdScan, extractText } from './scanner.js';

/** A fake clamd that decodes the INSTREAM framing and answers like the real daemon. */
function fakeClamd(verdict: (data: Buffer) => string): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let p = 10;
      const parts: Buffer[] = [];
      while (p + 4 <= buf.length) {
        const len = buf.readUInt32BE(p);
        if (len === 0) {
          const data = Buffer.concat(parts);
          received.push(data);
          s.end(`stream: ${verdict(data)}\0`);
          return;
        }
        if (p + 4 + len > buf.length) return;
        parts.push(buf.subarray(p + 4, p + 4 + len));
        p += 4 + len;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, received })));
}

let open: Server | undefined;
afterEach(() => open?.close());

describe('clamd INSTREAM client', () => {
  it('streams the whole content in framed chunks and reports a clean result', async () => {
    const fake = await fakeClamd(() => 'OK');
    open = fake.server;
    const content = Buffer.alloc(200_000, 7);
    expect(await clamdScan('127.0.0.1', fake.port, content)).toEqual({ clean: true });
    expect(fake.received[0]!.equals(content)).toBe(true);
  });

  it('reports the signature the scanner found', async () => {
    const fake = await fakeClamd((d) => (d.toString().includes('EICAR') ? 'Win.Test.EICAR_HDB-1 FOUND' : 'OK'));
    open = fake.server;
    expect(await clamdScan('127.0.0.1', fake.port, Buffer.from('xx EICAR yy'))).toEqual({ clean: false, signature: 'Win.Test.EICAR_HDB-1' });
  });

  it('fails when the scanner cannot be reached or answers nonsense', async () => {
    await expect(clamdScan('127.0.0.1', 1, Buffer.from('x'), 2_000)).rejects.toThrow(/unreachable|timed out/);
    const fake = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    open = fake.server;
    await expect(clamdScan('127.0.0.1', fake.port, Buffer.from('x'))).rejects.toThrow(/answered/);
  });
});

describe('text extraction', () => {
  it('indexes text and CSV only', () => {
    expect(extractText('text/plain', Buffer.from('pump seal'))).toBe('pump seal');
    expect(extractText('application/pdf', Buffer.from('%PDF'))).toBeNull();
  });
});
