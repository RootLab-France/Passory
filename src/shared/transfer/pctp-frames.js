/**
 * PCTP — Framing binaire des messages.
 *
 * Chaque frame sur le transport a la structure :
 *
 *   [magic:4]     "PCTP" (0x50 0x43 0x54 0x50)
 *   [version:1]   0x01
 *   [type:1]      voir MSG_TYPES
 *   [length:4]    BE uint32, longueur du payload
 *   [payload:N]   données brutes
 *
 * La taille max d'un payload est 16 MB pour éviter des frames monstres qui
 * bloqueraient le parseur côté receveur.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryPCTPFrames = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MAGIC = new Uint8Array([0x50, 0x43, 0x54, 0x50]);
  const VERSION = 0x01;
  const HEADER_LEN = 10;
  const MAX_PAYLOAD = 16 * 1024 * 1024;

  const MSG_TYPES = Object.freeze({
    CLIENT_HELLO:  0x01,
    SERVER_HELLO:  0x02,
    SAS_CONFIRM:   0x03,   // confirmation SAS authentifiée (HMAC de la transcription)
    REVEAL:        0x04,   // v2 : révélation de la clé engagée dans CLIENT_HELLO
    MANIFEST:      0x10,
    ITEM:          0x11,
    SETTINGS:      0x12,
    DONE:          0x13,
    ERROR:         0xf0,
    ABORT:         0xff,
  });

  function encodeFrame(type, payload) {
    if (!(payload instanceof Uint8Array)) throw new TypeError('payload: Uint8Array requis');
    if (payload.length > MAX_PAYLOAD) throw new RangeError('payload trop grand');
    const buf = new Uint8Array(HEADER_LEN + payload.length);
    buf.set(MAGIC, 0);
    buf[4] = VERSION;
    buf[5] = type & 0xff;
    const len = payload.length;
    buf[6] = (len >>> 24) & 0xff;
    buf[7] = (len >>> 16) & 0xff;
    buf[8] = (len >>> 8)  & 0xff;
    buf[9] = (len)        & 0xff;
    buf.set(payload, HEADER_LEN);
    return buf;
  }

  /**
   * Frame decoder streamable.
   * Alimente avec feed(bytes) ; chaque appel à nextFrame() retourne une
   * frame complète {type, payload} ou null si le buffer est incomplet.
   */
  class FrameDecoder {
    constructor() {
      this.chunks = [];
      this.total = 0;
    }

    feed(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('feed: Uint8Array');
      if (this.total + bytes.length > MAX_PAYLOAD) throw new RangeError('FrameDecoder: buffer overflow — données malformées ou attaque');
      this.chunks.push(bytes);
      this.total += bytes.length;
    }

    _peek(n) {
      if (this.total < n) return null;
      const out = new Uint8Array(n);
      let remaining = n;
      let offset = 0;
      for (const ch of this.chunks) {
        if (remaining === 0) break;
        const take = Math.min(remaining, ch.length);
        out.set(ch.subarray(0, take), offset);
        offset += take;
        remaining -= take;
      }
      return out;
    }

    _consume(n) {
      if (this.total < n) throw new Error('consume > total');
      this.total -= n;
      let remaining = n;
      while (remaining > 0) {
        const ch = this.chunks[0];
        if (ch.length <= remaining) {
          remaining -= ch.length;
          this.chunks.shift();
        } else {
          this.chunks[0] = ch.subarray(remaining);
          remaining = 0;
        }
      }
    }

    nextFrame() {
      if (this.total < HEADER_LEN) return null;
      const header = this._peek(HEADER_LEN);
      for (let i = 0; i < 4; i++) if (header[i] !== MAGIC[i]) throw new Error('frame magic invalide');
      const version = header[4];
      if (version !== VERSION) throw new Error(`frame version non supportée : ${version}`);
      const type = header[5];
      const len = (header[6] << 24 >>> 0) | (header[7] << 16) | (header[8] << 8) | header[9];
      if (len > MAX_PAYLOAD) throw new Error('frame payload > MAX_PAYLOAD');
      if (this.total < HEADER_LEN + len) return null;
      const full = this._peek(HEADER_LEN + len);
      this._consume(HEADER_LEN + len);
      return { type, payload: full.subarray(HEADER_LEN) };
    }
  }

  return { MAGIC, VERSION, HEADER_LEN, MAX_PAYLOAD, MSG_TYPES, encodeFrame, FrameDecoder };
});
