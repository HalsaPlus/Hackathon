import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// A minimal WebSocket server side (RFC 6455) for the live updates: the
// handshake, text messages, ping/pong and close. Enough for small JSON
// messages between MMD and its own pages; no extensions, no binary data.
// Written here instead of adding a dependency.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

export class LiveSocket extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private readonly socket: Duplex;
  open = true;

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }

  send(text: string) {
    if (this.open) this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  ping() {
    if (this.open) this.socket.write(frame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.socket.write(frame(0x8, payload));
    this.socket.end();
    this.closed();
  }

  private closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009);
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_PAYLOAD) return this.close(1009);
      if (!masked) return this.close(1002); // clients must mask
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + 4 + length);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        if (this.open) this.socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) {
        this.emit('pong');
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (Buffer.concat(this.fragments).length > MAX_PAYLOAD) return this.close(1009);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', text);
        }
        continue;
      }
      return this.close(1003); // binary or unknown: not accepted
    }
  }
}

function frame(opcode: number, payload: Buffer) {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = length;
  else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Refuses an upgrade with a plain HTTP status. */
export function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Completes the WebSocket handshake, or refuses it; returns the socket when accepted. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex): LiveSocket | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new LiveSocket(socket);
}
