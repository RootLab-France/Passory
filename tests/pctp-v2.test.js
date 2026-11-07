/** PCTP v2 — échange réel X25519, transfert complet, attaques de l'homme du milieu (audit M5). */
'use strict';
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('node:crypto').webcrypto;
const assert = require('node:assert/strict');
const { createX25519Provider } = require('../src/shared/crypto/x25519.js');
const { createSenderSession, createReceiverSession } = require('../src/shared/transfer/item-sharing.js');
const { PCTPSession } = require('../src/shared/transfer/pctp-protocol.js');
const F = require('../src/shared/transfer/pctp-frames.js');

function frames(bytes) { const d = new F.FrameDecoder(); d.feed(bytes); const out = []; let f; while ((f = d.nextFrame())) out.push(f); return out; }
let n = 0; async function t(name, fn) { n++; process.stdout.write(`[${n}] ${name}... `); await fn(); console.log('OK'); }

(async () => {
  const x = await createX25519Provider();

  await t('Transfert complet sender → receiver, SAS identique de 40 bits', async () => {
    const items = [{ id: '1', type: 'password', payload: { label: 'Factice', password: 'p' } }];
    const S = createSenderSession({ x25519Provider: x, items }), Rc = createReceiverSession({ x25519Provider: x });
    const hello = await S.start();
    assert.equal(frames(hello)[0].payload.length, 33, 'ClientHello ne contient que l\'engagement');
    const r1 = await Rc.receive(hello);                 // → ServerHello
    assert.equal(Rc.sas, null, 'pas de SAS avant la révélation');
    const s1 = await S.receive(r1.toSend);              // → Reveal + sas-ready
    const r2 = await Rc.receive(s1.toSend);             // receiver vérifie l'engagement
    assert.ok(S.sas && S.sas === Rc.sas); assert.match(S.sas, /^[^-\s]+-[^-\s]+-[^-\s]+ \d{5}$/);
    const cS = await S.confirmSAS(), cR = await Rc.confirmSAS();
    await S.receive(cR);
    const out = await S.receive(new Uint8Array(0));
    const rr = await Rc.receive(cS);
    // le sender envoie dès 'ready' (déclenché par la confirmation du pair)
    const sAll = await S.receive(new Uint8Array(0));
    void out; void sAll; void r2;
    assert.ok(rr.events.some((e) => e.type === 'peer-confirmed-sas'));
  });

  await t('Transfert de bout en bout via flux d\'octets', async () => {
    const items = [{ id: '1', type: 'password', payload: { label: 'A' } }, { id: '2', type: 'password', payload: { label: 'B' } }];
    const S = createSenderSession({ x25519Provider: x, items }), Rc = createReceiverSession({ x25519Provider: x });
    let toR = await S.start(); let got = null;
    const toS = (await Rc.receive(toR)).toSend;
    toR = (await S.receive(toS)).toSend;
    await Rc.receive(toR);
    const confR = await Rc.confirmSAS();
    const confS = await S.confirmSAS();
    const resR = await Rc.receive(confS);
    assert.ok(resR.events.some((e) => e.type === 'peer-confirmed-sas'));
    const resS = await S.receive(confR); // peer confirmé + self confirmé → ready → envoi
    const final = await Rc.receive(resS.toSend);
    got = final.events.find((e) => e.type === 'items-received');
    assert.ok(got && got.items.length === 2 && got.items[1].payload.label === 'B');
  });

  await t('Ordre inverse : le receiver confirme d\'abord, le sender envoie quand même', async () => {
    const items = [{ id: '1', type: 'password', payload: { label: 'Z' } }];
    const S = createSenderSession({ x25519Provider: x, items }), Rc = createReceiverSession({ x25519Provider: x });
    const sv = (await Rc.receive(await S.start())).toSend;
    await Rc.receive((await S.receive(sv)).toSend);
    await S.receive(await Rc.confirmSAS());
    const bytes = await S.confirmSAS();
    const res = await Rc.receive(bytes);
    const got = res.events.find((e) => e.type === 'items-received');
    assert.ok(got && got.items.length === 1 && got.items[0].payload.label === 'Z');
  });

  await t('MITM : substitution de clé à la révélation → engagement rejeté', async () => {
    const S = new PCTPSession({ role: 'sender', x25519Provider: x }), Rv = new PCTPSession({ role: 'receiver', x25519Provider: x });
    const hello = await S.createClientHello();
    const ev1 = await Rv.feed(hello);
    const ev2 = await S.feed(ev1.find((e) => e.type === 'send').frame);
    const reveal = frames(ev2.find((e) => e.type === 'send').frame)[0];
    const forged = new Uint8Array(reveal.payload); const m = x.generateKeyPair(); forged.set(m.pub, 0);
    const ev3 = await Rv.feed(F.encodeFrame(F.MSG_TYPES.REVEAL, forged));
    assert.ok(ev3.some((e) => e.type === 'error' && /Engagement/.test(e.message)));
  });

  await t('MITM relais avec ses propres clés : SAS différentes (pas de force brute possible)', async () => {
    let diff = 0;
    for (let i = 0; i < 20; i++) {
      const A = new PCTPSession({ role: 'sender', x25519Provider: x }), B = new PCTPSession({ role: 'receiver', x25519Provider: x });
      const MA = new PCTPSession({ role: 'receiver', x25519Provider: x }), MB = new PCTPSession({ role: 'sender', x25519Provider: x });
      const hA = await A.createClientHello();
      const svA = (await MA.feed(hA)).find((e) => e.type === 'send').frame;   // M répond à A AVANT de connaître la clé de A
      const hM = await MB.createClientHello();                                 // M s'engage envers B
      const svB = (await B.feed(hM)).find((e) => e.type === 'send').frame;
      const rvM = (await MB.feed(svB)).find((e) => e.type === 'send').frame;
      await B.feed(rvM);
      const rvA = (await A.feed(svA)).find((e) => e.type === 'send').frame;
      await MA.feed(rvA);
      if (A.sas !== B.sas) diff++;
    }
    assert.equal(diff, 20);
  });

  await t('Confirmation de clé forgée rejetée', async () => {
    const S = new PCTPSession({ role: 'sender', x25519Provider: x }), Rv = new PCTPSession({ role: 'receiver', x25519Provider: x });
    const e1 = await Rv.feed(await S.createClientHello());
    const e2 = await S.feed(e1.find((e) => e.type === 'send').frame);
    await Rv.feed(e2.find((e) => e.type === 'send').frame);
    const ev = await S.feed(F.encodeFrame(F.MSG_TYPES.SAS_CONFIRM, new Uint8Array(32)));
    assert.ok(ev.some((e) => e.type === 'error' && /Confirmation de clé/.test(e.message)));
    const ev0 = await Rv.feed(F.encodeFrame(F.MSG_TYPES.SAS_CONFIRM, new Uint8Array(0)));
    assert.ok(ev0.some((e) => e.type === 'error'), 'ancien format v1 (confirmation vide) refusé');
  });

  await t('Client v1 (ClientHello de 48 octets) refusé avec message explicite', async () => {
    const Rv = new PCTPSession({ role: 'receiver', x25519Provider: x });
    const ev = await Rv.feed(F.encodeFrame(F.MSG_TYPES.CLIENT_HELLO, new Uint8Array(48).fill(7)));
    assert.ok(ev.some((e) => e.type === 'error' && /incompatible/.test(e.message)));
  });

  await t('Course : confirmation utilisateur et confirmation du pair simultanées (50 essais)', async () => {
    for (let i = 0; i < 50; i++) {
      const items = [{ id: '1', type: 'password', payload: { label: 'R' } }];
      const S = createSenderSession({ x25519Provider: x, items }), Rc = createReceiverSession({ x25519Provider: x });
      await Rc.receive((await S.receive((await Rc.receive(await S.start())).toSend)).toSend);
      const cR = await Rc.confirmSAS();
      const [bytesConfirm, resRecv] = await Promise.all([S.confirmSAS(), S.receive(cR)]);
      const stream = [bytesConfirm, resRecv.toSend].filter(Boolean);
      let got = null;
      for (const b of stream) { const r = await Rc.receive(b); got = got || r.events.find((e) => e.type === 'items-received'); assert.ok(!r.events.some((e) => e.type === 'error'), 'pas d\'erreur'); }
      assert.ok(got && got.items.length === 1, 'essai ' + i);
    }
  });

  await t('Intermédiaire qui supprime un ITEM : transfert refusé', async () => {
    const items = [1, 2, 3].map((k) => ({ id: String(k), type: 'password', payload: { label: 'L' + k } }));
    const S2 = createSenderSession({ x25519Provider: x, items }), R2 = createReceiverSession({ x25519Provider: x });
    await R2.receive((await S2.receive((await R2.receive(await S2.start())).toSend)).toSend);
    await S2.confirmSAS();
    const out = await S2.receive(await R2.confirmSAS());
    const fr = frames(out.toSend);
    const kept = fr.filter((f, i) => !(f.type === F.MSG_TYPES.ITEM && i === 2)).map((f) => F.encodeFrame(f.type, f.payload));
    let errors = [], got = null;
    for (const b of kept) { const r = await R2.receive(b); errors.push(...r.events.filter((e) => e.type === 'error')); got = got || r.events.find((e) => e.type === 'items-received'); }
    assert.ok(errors.length > 0 && !got, 'suppression détectée');
  });

  console.log('\nPCTP v2 : tous les tests passés.');
  process.exit(0);
})().catch((e) => { console.error('\nÉCHEC :', e.stack || e); process.exit(1); });
