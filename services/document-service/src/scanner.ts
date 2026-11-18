/**
 * Optional antivirus scan through a ClamAV daemon (clamd), INSTREAM protocol:
 *   "zINSTREAM\0", then chunks of <4-byte big-endian length><data>, then a zero length.
 * The daemon answers "stream: OK" or "stream: <signature> FOUND".
 *
 * When CLAMAV_HOST is set every upload is scanned and an unreachable scanner REFUSES the upload
 * (fail closed). Without it the built-in type and EICAR check is the only scan (see rules.ts).
 */
import { connect } from 'node:net';

export type ClamResult = { clean: true } | { clean: false; signature: string };

const CHUNK = 64 * 1024;

export function clamdScan(host: string, port: number, content: Buffer, timeoutMs = 30_000): Promise<ClamResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let answer = '';
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
    };
    socket.setTimeout(timeoutMs, () => done(new Error('virus scanner timed out')));
    socket.on('error', (err) => done(new Error(`virus scanner unreachable: ${err.message}`)));
    socket.on('data', (d) => (answer += d.toString('utf8')));
    socket.on('end', () => {
      const text = answer.replace(/\0/g, '').trim();
      const found = /^stream: (.+) FOUND$/.exec(text);
      if (/^stream: OK$/.test(text)) resolve({ clean: true });
      else if (found) resolve({ clean: false, signature: found[1]! });
      else reject(new Error(`virus scanner answered: ${text || '(nothing)'}`));
      socket.destroy();
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < content.length; i += CHUNK) {
        const part = content.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // zero length: end of stream
    });
  });
}

/** Plain text of uploads whose text can be indexed (text and CSV only; no PDF or OCR). */
export function extractText(contentType: string, content: Buffer): string | null {
  if (contentType !== 'text/plain' && contentType !== 'text/csv') return null;
  return content.toString('utf8').replace(/\0/g, '').slice(0, 1_000_000);
}
