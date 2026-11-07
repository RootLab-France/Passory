'use strict';

/**
 * Couche applicative de partage d'items par câble (PCTP).
 *
 * Encapsule PCTPSession pour l'envoi/réception d'items déchiffrés.
 * Le transport (WebUSB, TCP, adb…) reste à brancher par la couche platform.
 *
 * Côté sender (Alice) :
 *   const sess = createSenderSession({ x25519Provider, items });
 *   transport.send(await sess.start());
 *   transport.onData(async bytes => {
 *     const { toSend, events } = await sess.receive(bytes);
 *     if (toSend) transport.send(toSend);
 *     for (const ev of events) { ... }
 *   });
 *   sess.confirmSAS();  // après affichage + validation utilisateur
 *
 * Côté receiver (Bob) :
 *   const sess = createReceiverSession({ x25519Provider });
 *   transport.onData(async bytes => {
 *     const { toSend, events } = await sess.receive(bytes);
 *     if (toSend) transport.send(toSend);
 *     for (const ev of events) {
 *       if (ev.type === 'items-received') saveItems(ev.items);
 *     }
 *   });
 *   sess.confirmSAS();
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./pctp-protocol.js'));
  } else {
    root.PassoryItemSharing = factory(root.PassoryPCTP);
  }
})(typeof self !== 'undefined' ? self : this, function (PCTP) {

  const { PCTPSession } = PCTP;

  function createSenderSession({ x25519Provider, items = [] }) {
    const sess = new PCTPSession({ role: 'sender', x25519Provider });
    // Toutes les opérations sur la session passent par une file : un clic de
    // confirmation et une frame du pair ne peuvent plus s'entrelacer.
    let _queue = Promise.resolve();
    const serial = (fn) => { const p = _queue.then(fn, fn); _queue = p.catch(() => {}); return p; };
    let _manifest = null;
    let _sent = false;

    /** Frames manifest + items + done (une seule fois). */
    async function transferFrames() {
      if (_sent) return [];
      _sent = true;
      const manifest = { count: items.length, version: 1 };
      _manifest = manifest;
      const out = [await sess.sendEncrypted('manifest', manifest)];
      for (const item of items) out.push(await sess.sendEncrypted('item', item));
      out.push(await sess.sendEncrypted('done', null));
      return out;
    }

    return {
      /** Génère le ClientHello à envoyer au receiver. */
      async start() {
        return sess.createClientHello();
      },

      /** Valide la SAS côté utilisateur. Retourne la frame SAS_CONFIRM à envoyer. */
      confirmSAS() {
        return serial(async () => {
          // SAS_CONFIRM, suivi des éléments si le pair avait déjà confirmé.
          const events = await sess.userConfirmsSAS();
          const sends = events.filter(e => e.type === 'send').map(e => e.frame);
          if (events.some(e => e.type === 'ready')) sends.push(...(await transferFrames()));
          return sends.length ? _mergeFrames(sends) : null;
        });
      },

      /** Alimente le moteur avec des octets reçus du transport. */
      receive(bytes) {
        return serial(async () => {
          const raw = await sess.feed(bytes);
          const toSendFrames = [];
          const events = [];

          for (const ev of raw) {
            if (ev.type === 'send') {
              toSendFrames.push(ev.frame);
              continue;
            }
            if (ev.type === 'ready') {
              toSendFrames.push(...(await transferFrames()));
              events.push({ type: 'transfer-started', count: items.length });
              continue;
            }
            events.push(ev);
          }

          return {
            toSend: toSendFrames.length
              ? _mergeFrames(toSendFrames)
              : null,
            events,
          };
        });
      },

      get sas() { return sess.sas; },
      get state() { return sess.state; },
      get itemCount() { return items.length; },
      abort(reason) { return sess.abort(reason); },
    };
  }

  function createReceiverSession({ x25519Provider }) {
    const sess = new PCTPSession({ role: 'receiver', x25519Provider });
    let _queue = Promise.resolve();
    const serial = (fn) => { const p = _queue.then(fn, fn); _queue = p.catch(() => {}); return p; };
    const receivedItems = [];
    let _manifest = null;

    return {
      /** Valide la SAS côté utilisateur. Retourne la frame SAS_CONFIRM à envoyer. */
      confirmSAS() {
        return serial(async () => {
          const events = await sess.userConfirmsSAS();
          const sends = events.filter(e => e.type === 'send').map(e => e.frame);
          return sends.length ? sends[0] : null;
        });
      },

      /** Alimente le moteur avec des octets reçus du transport. */
      receive(bytes) {
        return serial(async () => {
          const raw = await sess.feed(bytes);
          const toSendFrames = [];
          const events = [];

          for (const ev of raw) {
            if (ev.type === 'send') {
              toSendFrames.push(ev.frame);
              continue;
            }
            if (ev.type === 'message') {
              if (ev.kind === 'manifest') {
                _manifest = ev.data;
                events.push({ type: 'transfer-started', count: ev.data.count });
              } else if (ev.kind === 'item') {
                receivedItems.push(ev.data);
                events.push({ type: 'item-received', item: ev.data, received: receivedItems.length, total: _manifest ? _manifest.count : null });
              }
              continue;
            }
            if (ev.type === 'done') {
              if (!_manifest || receivedItems.length !== _manifest.count) {
                events.push({ type: 'error', message: `Transfert incomplet : ${receivedItems.length} élément(s) reçu(s) sur ${_manifest ? _manifest.count : '?'} annoncé(s).` });
                continue;
              }
              events.push({ type: 'items-received', items: receivedItems.slice() });
              continue;
            }
            events.push(ev);
          }

          return {
            toSend: toSendFrames.length
              ? _mergeFrames(toSendFrames)
              : null,
            events,
          };
        });
      },

      get sas() { return sess.sas; },
      get state() { return sess.state; },
      get items() { return receivedItems.slice(); },
      abort(reason) { return sess.abort(reason); },
    };
  }

  function _mergeFrames(frames) {
    const total = frames.reduce((s, f) => s + f.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const f of frames) { out.set(f, offset); offset += f.length; }
    return out;
  }

  return { createSenderSession, createReceiverSession };
});
