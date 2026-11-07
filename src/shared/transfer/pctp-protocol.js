/**
 * PCTP — Passory Cable Transfer Protocol (handshake + session).
 *
 * Ce module est transport-agnostic : il expose une machine d'état qui
 * produit des frames à envoyer et consomme des frames reçues. Le wiring
 * avec le vrai transport (WebUSB, TCP tethered, adb, Multipeer BT) est
 * fait dans les couches platform/*.
 *
 * PROTOCOLE v2 (audit M5 — résiste à l'homme du milieu) :
 *   1. ClientHello : [version=2][commit(32)], commit = SHA-256(label‖ephPubA‖nonceA)
 *      → le sender s'ENGAGE sur sa clé sans la révéler.
 *   2. ServerHello : [ephPubB(32)][nonceB(16)]
 *   3. Reveal      : [ephPubA(32)][nonceA(16)] ; le receiver vérifie l'engagement.
 *   4. th = SHA-256(commit‖ephPubA‖nonceA‖ephPubB‖nonceB)
 *      sessionKey = HKDF(shared, th, "passory-pctp-v2-key"), SAS = HKDF(..., 5 o) = 40 bits.
 *      Un intermédiaire doit fixer ses clés avant de connaître la SAS de l'autre
 *      côté : il ne peut plus la chercher par force brute (chance 2^-40).
 *   5. SAS_CONFIRM : HMAC-SHA256(confirmKey, rôle‖th) — confirmation de clé.
 *
 * Ancienne description v1 (pour mémoire) :
 *   1. ClientHello  : {version, ephPubA, nonceA}
 *   2. ServerHello  : {ephPubB, nonceB}
 *   3. Les deux côtés dérivent :
 *        shared = X25519(ephPriv, ephPub_peer)
 *        sessionKey = HKDF(shared, salt=nonceA||nonceB, info="passory-pctp-v1", 32)
 *        sasBytes   = HKDF(shared, salt=nonceA||nonceB, info="passory-pctp-sas", 4)
 *        SAS = to_words(sasBytes)   (affiché à l'utilisateur sur les 2 écrans)
 *   4. Confirmation utilisateur (out-of-band — appui bouton "OK" sur chaque appareil).
 *   5. Transfert : chaque message applicatif est chiffré AES-256-GCM avec
 *      sessionKey et un nonce [senderId:1][counter:11].
 *
 * Dépendance obligatoire injectée :
 *   - x25519Provider : { generateKeyPair(): {priv, pub}, sharedSecret(priv, pub): Uint8Array }
 *     Implémenté via @noble/curves/ed25519 côté Electron et bundlé côté mobile.
 *
 * Usage type (côté sender/Alice) :
 *   const sess = new PCTPSession({ role: 'sender', x25519Provider });
 *   const hello = await sess.createClientHello();
 *   transport.send(hello);
 *   transport.onRecv(async (bytes) => {
 *     const events = await sess.feed(bytes);
 *     for (const ev of events) {
 *       if (ev.type === 'sas-ready')  showSASToUser(ev.sas);
 *       if (ev.type === 'peer-confirmed-sas') await userConfirmsSAS();
 *       if (ev.type === 'ready') sess.send({kind: 'manifest', ...});
 *     }
 *   });
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../crypto/random.js'),
      require('./pctp-frames.js')
    );
  } else {
    root.PassoryPCTP = factory(root.PassoryRandom, root.PassoryPCTPFrames);
  }
})(typeof self !== 'undefined' ? self : this, function (R, F) {

  const { MSG_TYPES, encodeFrame, FrameDecoder } = F;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // --- Dictionnaire SAS : 256 mots courts mnémotechniques ----
  // On affiche 2 mots (16 bits = 65 536 combinaisons, assez pour un
  // contrôle visuel utilisateur non-expert).
  // Liste courte choisie pour être prononçable en français et sans ambiguïté.
  const SAS_WORDS = [
    'abeille','acier','agent','aigle','ail','amande','amiral','ancre','ange','arc',
    'arbre','armure','artiste','astre','atome','atout','avion','bague','balle','banc',
    'barge','barre','basse','bateau','bougie','bouton','brave','brun','buffet','cable',
    'cactus','café','cage','caillou','camion','canard','canon','cape','carré','casque',
    'centre','cercle','cerf','chaine','chant','chat','chef','chemin','chêne','cheval',
    'chien','cible','ciel','cigogne','cime','cirque','citron','clair','clan','classe',
    'clé','cloche','coccinelle','code','coeur','coin','colline','comète','conte','coq',
    'coral','corbeau','corde','côte','couteau','craie','crème','crête','crin','cube',
    'cuivre','dahlia','dame','danse','date','dauphin','défi','dent','désert','devise',
    'diamant','digue','dîner','disque','dogue','donjon','doré','dragon','drap','droit',
    'échelle','écho','école','écran','écume','élan','émail','émir','émue','encre',
    'enjeu','envol','épée','épine','étage','étoile','étrier','ferme','fête','feu',
    'fil','fleur','flotte','forêt','four','fraise','franc','frein','frère','frise',
    'fronde','fruit','fuite','gaine','galet','galop','gamme','gant','gare','gel',
    'genou','gerbe','gibet','gîte','givre','globe','grain','grêle','grief','gris',
    'grive','grue','gué','habile','hache','haie','halle','havre','héros','hêtre',
    'hibou','hiver','hochet','huile','ivoire','jade','jambon','jardin','jaune','jeu',
    'jolie','jour','juge','juin','jumeau','kayak','kiosque','lac','lame','lampe',
    'larme','laurier','lever','lierre','lilas','lion','lire','livre','loge','long',
    'loup','lourd','lucarne','lune','lutin','lyre','magie','maire','malle','manche',
    'marée','matin','mat','menhir','merle','merveille','mesure','métal','midi','mineur',
    'miroir','moine','mole','moment','monde','monte','motte','mouette','mousse','mulot',
    'muraille','musée','nacelle','nage','neige','nerf','niche','nid','noir','note',
    'nuage','objet','ogre','ombre','once','orage','orbe','ordre','orge','orient',
    'orme','osier','ourson','ouvrage','paille','paix','panier','panthère','papillon','parc',
    'passerelle','pavé','pêche','perche','perle','phare','pic','pierre','pin','pinceau',
    'pion','pique','piste'
  ];
  // Assure un dictionnaire d'exactement 256 entrées (tronque ou complète).
  const SAS_DICT = SAS_WORDS.slice(0, 256);
  while (SAS_DICT.length < 256) SAS_DICT.push('mot' + SAS_DICT.length);

  /**
   * Convertit 4 octets en 2 mots + 2 chiffres → SAS humaine.
   * Ex: [0x8a, 0x3e, 0x12, 0xff] → "chat-brun 73" (mots + vérif numérique).
   */
  function bytesToSAS(sasBytes) {
    if (!(sasBytes instanceof Uint8Array) || sasBytes.length < 5) {
      throw new TypeError('sasBytes: Uint8Array ≥ 5 requis');
    }
    // 3 mots (24 bits) + nombre 16 bits = 40 bits
    const w1 = SAS_DICT[sasBytes[0]];
    const w2 = SAS_DICT[sasBytes[1]];
    const w3 = SAS_DICT[sasBytes[2]];
    const num = ((sasBytes[3] << 8) | sasBytes[4]).toString().padStart(5, '0');
    return `${w1}-${w2}-${w3} ${num}`;
  }

  const PROTOCOL_VERSION = 2;
  const COMMIT_LABEL = encoder.encode('passory-pctp-v2-commit');

  async function sha256(...parts) {
    let len = 0; for (const p of parts) len += p.length;
    const buf = new Uint8Array(len); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  }
  async function hmac(keyBytes, data) {
    const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
  }
  function ctEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  // --- HKDF helper (SubtleCrypto) ----
  async function hkdf(ikm, salt, info, length) {
    const k = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      k,
      length * 8
    );
    return new Uint8Array(bits);
  }

  async function aesGcmEncrypt(key, nonce, plaintext, aad) {
    const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      k, plaintext
    );
    return new Uint8Array(ct);
  }

  async function aesGcmDecrypt(key, nonce, ciphertext, aad) {
    const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      k, ciphertext
    );
    return new Uint8Array(pt);
  }

  /** État de la session. */
  const STATE = Object.freeze({
    INIT:              'init',
    WAITING_HELLO:     'waiting-hello',
    WAITING_REVEAL:    'waiting-reveal',
    SAS_PENDING:       'sas-pending',
    SAS_CONFIRMED:     'sas-confirmed',
    TRANSFERRING:      'transferring',
    DONE:              'done',
    ABORTED:           'aborted',
  });

  class PCTPSession {
    /**
     * @param {object} opts
     * @param {'sender'|'receiver'} opts.role
     * @param {object} opts.x25519Provider { generateKeyPair(), sharedSecret(priv, pub) }
     */
    constructor(opts) {
      if (!opts || (opts.role !== 'sender' && opts.role !== 'receiver')) {
        throw new Error('role: sender | receiver requis');
      }
      if (!opts.x25519Provider || typeof opts.x25519Provider.generateKeyPair !== 'function') {
        throw new Error('x25519Provider requis');
      }
      this.role = opts.role;
      this.senderId = this.role === 'sender' ? 0 : 1;
      this.x = opts.x25519Provider;
      this.decoder = new FrameDecoder();
      this.state = STATE.INIT;
      this.eph = null;      // { priv, pub }
      this.nonceSelf = null;
      this.noncePeer = null;
      this.peerPub = null;
      this.sessionKey = null;
      this.sas = null;
      this._selfConfirmed = false;
      this._peerConfirmed = false;
      this.sendCounter = 0;
      this.recvCounter = 0;
      this._seenNonces = new Set();
      this.commit = null;       // engagement du sender (v2)
      this.transcript = null;   // th
      this.confirmKey = null;
    }

    /** Génère ClientHello v2 (sender) : engagement sur la clé, sans la révéler. */
    async createClientHello() {
      if (this.role !== 'sender') throw new Error('seul le sender génère ClientHello');
      if (this.state !== STATE.INIT) throw new Error('state != INIT');
      this.eph = this.x.generateKeyPair();
      this.nonceSelf = R.randomBytes(16);
      this.commit = await sha256(COMMIT_LABEL, this.eph.pub, this.nonceSelf);
      const payload = new Uint8Array(33);
      payload[0] = PROTOCOL_VERSION;
      payload.set(this.commit, 1);
      this.state = STATE.WAITING_HELLO;
      return encodeFrame(MSG_TYPES.CLIENT_HELLO, payload);
    }

    /** Génère ServerHello (côté receiver, en réponse à ClientHello). */
    async _createServerHello() {
      this.eph = this.x.generateKeyPair();
      this.nonceSelf = R.randomBytes(16);
      const payload = new Uint8Array(48);
      payload.set(this.eph.pub, 0);
      payload.set(this.nonceSelf, 32);
      return encodeFrame(MSG_TYPES.SERVER_HELLO, payload);
    }

    async _deriveSession() {
      const shared = this.x.sharedSecret(this.eph.priv, this.peerPub);
      if (shared.every((b) => b === 0)) throw new Error('Secret partagé invalide (point de faible ordre)');
      const pubA = this.role === 'sender' ? this.eph.pub : this.peerPub;
      const nA   = this.role === 'sender' ? this.nonceSelf : this.noncePeer;
      const pubB = this.role === 'sender' ? this.peerPub : this.eph.pub;
      const nB   = this.role === 'sender' ? this.noncePeer : this.nonceSelf;
      this.transcript = await sha256(this.commit, pubA, nA, pubB, nB);
      this.sessionKey = await hkdf(shared, this.transcript, 'passory-pctp-v2-key', 32);
      this.confirmKey = await hkdf(shared, this.transcript, 'passory-pctp-v2-confirm', 32);
      const sasBytes = await hkdf(shared, this.transcript, 'passory-pctp-v2-sas', 5);
      this.sas = bytesToSAS(sasBytes);
    }

    async _confirmTag(role) {
      const r = new Uint8Array([role === 'sender' ? 0x53 : 0x52]);
      const data = new Uint8Array(1 + this.transcript.length);
      data.set(r, 0); data.set(this.transcript, 1);
      return hmac(this.confirmKey, data);
    }

    /**
     * Alimente le moteur avec des octets bruts reçus du transport.
     * Retourne un tableau d'events à traiter par l'appelant :
     *   - { type: 'send', frame: Uint8Array }      → à envoyer au peer
     *   - { type: 'sas-ready', sas: string }       → afficher à l'utilisateur
     *   - { type: 'peer-confirmed-sas' }
     *   - { type: 'ready' }                         → sender peut envoyer des items
     *   - { type: 'message', kind: string, data }   → message applicatif reçu
     *   - { type: 'done' }
     *   - { type: 'aborted', reason: string }
     *   - { type: 'error', message: string }
     */
    async feed(bytes) {
      const events = [];
      try {
        this.decoder.feed(bytes);
        let frame;
        while ((frame = this.decoder.nextFrame())) {
          const handled = await this._handleFrame(frame);
          for (const e of handled) events.push(e);
        }
      } catch (err) {
        this.state = STATE.ABORTED;
        events.push({ type: 'error', message: err.message });
      }
      return events;
    }

    async _handleFrame(frame) {
      const events = [];
      const { type, payload } = frame;

      if (type === MSG_TYPES.ABORT) {
        this.state = STATE.ABORTED;
        events.push({ type: 'aborted', reason: decoder.decode(payload) || 'peer abort' });
        return events;
      }

      if (type === MSG_TYPES.CLIENT_HELLO) {
        if (this.role !== 'receiver' || this.state !== STATE.INIT) throw new Error('CLIENT_HELLO inattendu');
        if (payload.length !== 33 || payload[0] !== PROTOCOL_VERSION) {
          throw new Error('Version PCTP incompatible : mettez à jour Passory sur les deux appareils.');
        }
        this.commit = payload.slice(1, 33);
        const hello = await this._createServerHello();
        events.push({ type: 'send', frame: hello });
        this.state = STATE.WAITING_REVEAL;
        return events;
      }

      if (type === MSG_TYPES.SERVER_HELLO) {
        if (this.role !== 'sender' || this.state !== STATE.WAITING_HELLO) throw new Error('SERVER_HELLO inattendu');
        if (payload.length !== 48) throw new Error('SERVER_HELLO payload invalide');
        const peerPubS = payload.slice(0, 32);
        if (peerPubS.every(b => b === 0)) throw new Error('Clé publique peer invalide (all-zeros)');
        this.peerPub = peerPubS;
        this.noncePeer = payload.slice(32, 48);
        // Révélation de la clé engagée
        const reveal = new Uint8Array(48);
        reveal.set(this.eph.pub, 0);
        reveal.set(this.nonceSelf, 32);
        events.push({ type: 'send', frame: encodeFrame(MSG_TYPES.REVEAL, reveal) });
        await this._deriveSession();
        this.state = STATE.SAS_PENDING;
        events.push({ type: 'sas-ready', sas: this.sas });
        return events;
      }

      if (type === MSG_TYPES.REVEAL) {
        if (this.role !== 'receiver' || this.state !== STATE.WAITING_REVEAL) throw new Error('REVEAL inattendu');
        if (payload.length !== 48) throw new Error('REVEAL payload invalide');
        const pub = payload.slice(0, 32), nonce = payload.slice(32, 48);
        if (pub.every(b => b === 0)) throw new Error('Clé publique peer invalide (all-zeros)');
        const expected = await sha256(COMMIT_LABEL, pub, nonce);
        if (!ctEqual(expected, this.commit)) {
          this.state = STATE.ABORTED;
          throw new Error('Engagement PCTP invalide : connexion interceptée ou corrompue.');
        }
        this.peerPub = pub;
        this.noncePeer = nonce;
        await this._deriveSession();
        this.state = STATE.SAS_PENDING;
        events.push({ type: 'sas-ready', sas: this.sas });
        return events;
      }

      if (type === MSG_TYPES.SAS_CONFIRM) {
        if (this.state !== STATE.SAS_PENDING && this.state !== STATE.SAS_CONFIRMED) {
          throw new Error('SAS_CONFIRM inattendu');
        }
        const expected = await this._confirmTag(this.role === 'sender' ? 'receiver' : 'sender');
        if (payload.length !== 32 || !ctEqual(payload, expected)) {
          this.state = STATE.ABORTED;
          throw new Error('Confirmation de clé invalide : les deux appareils ne partagent pas la même session.');
        }
        this._peerConfirmed = true;
        events.push({ type: 'peer-confirmed-sas' });
        if (this._selfConfirmed) {
          this.state = STATE.TRANSFERRING;
          events.push({ type: 'ready' });
        }
        return events;
      }

      // À partir d'ici, la session doit être transférable et les frames chiffrées.
      if (this.state !== STATE.TRANSFERRING) throw new Error(`frame 0x${type.toString(16)} hors session`);

      // Format frame chiffrée payload : [nonce(12)][ciphertext+tag(N)]
      if (payload.length < 12 + 16) throw new Error('payload chiffré trop court');
      const nonce = payload.subarray(0, 12);
      // Nonce du pair : préfixe = son identifiant, compteur strictement
      // séquentiel (le transport est ordonné) → suppression ou réordonnancement
      // d'une frame détecté (relecture #2).
      const peerId = this.role === 'sender' ? 1 : 0;
      const counter = ((nonce[8] << 24) | (nonce[9] << 16) | (nonce[10] << 8) | nonce[11]) >>> 0;
      if (nonce[0] !== peerId || counter !== this.recvCounter + 1) {
        this.state = STATE.ABORTED;
        throw new Error('Séquence PCTP invalide : frame manquante, rejouée ou réordonnée.');
      }
      const nonceKey = nonce.join(',');
      if (this._seenNonces.has(nonceKey)) {
        this.state = STATE.ABORTED;
        throw new Error('Replay détecté : nonce déjà vu.');
      }
      const ct = payload.subarray(12);
      // AAD = type(1B) pour lier type + contenu
      const aad = new Uint8Array([type]);
      const plain = await aesGcmDecrypt(this.sessionKey, nonce, ct, aad);
      this._seenNonces.add(nonceKey);
      this.recvCounter = counter;

      if (type === MSG_TYPES.DONE) {
        this.state = STATE.DONE;
        events.push({ type: 'done' });
        return events;
      }

      if (type === MSG_TYPES.ERROR) {
        const msg = decoder.decode(plain);
        this.state = STATE.ABORTED;
        events.push({ type: 'error', message: msg });
        return events;
      }

      // MANIFEST / ITEM / SETTINGS : payload JSON
      let parsed;
      try { parsed = JSON.parse(decoder.decode(plain)); }
      catch { throw new Error('payload JSON invalide'); }
      const kind = {
        [MSG_TYPES.MANIFEST]: 'manifest',
        [MSG_TYPES.ITEM]: 'item',
        [MSG_TYPES.SETTINGS]: 'settings',
      }[type] || 'unknown';
      events.push({ type: 'message', kind, data: parsed });
      return events;
    }

    /** L'utilisateur a visuellement validé la SAS sur CE côté. */
    async userConfirmsSAS() {
      if (this.state !== STATE.SAS_PENDING && this.state !== STATE.SAS_CONFIRMED) {
        throw new Error('confirmSAS hors état SAS_PENDING');
      }
      this._selfConfirmed = true;
      const frame = encodeFrame(MSG_TYPES.SAS_CONFIRM, await this._confirmTag(this.role));
      const events = [{ type: 'send', frame }];
      this.state = STATE.SAS_CONFIRMED;
      if (this._peerConfirmed) {
        this.state = STATE.TRANSFERRING;
        events.push({ type: 'ready' });
      }
      return events;
    }

    /** Génère une frame chiffrée pour un message applicatif. */
    async sendEncrypted(kind, data) {
      if (this.state !== STATE.TRANSFERRING) throw new Error('sendEncrypted hors TRANSFERRING');
      const typeMap = { manifest: MSG_TYPES.MANIFEST, item: MSG_TYPES.ITEM, settings: MSG_TYPES.SETTINGS, done: MSG_TYPES.DONE, error: MSG_TYPES.ERROR };
      const type = typeMap[kind];
      if (type === undefined) throw new Error('kind inconnu : ' + kind);
      const nonce = this._nextNonce();
      const plain = kind === 'done' ? new Uint8Array(0) : encoder.encode(typeof data === 'string' ? data : JSON.stringify(data));
      const aad = new Uint8Array([type]);
      const ct = await aesGcmEncrypt(this.sessionKey, nonce, plain, aad);
      const payload = new Uint8Array(12 + ct.length);
      payload.set(nonce, 0);
      payload.set(ct, 12);
      if (kind === 'done') this.state = STATE.DONE;
      return encodeFrame(type, payload);
    }

    /** Envoie une frame ABORT non chiffrée. */
    abort(reason) {
      this.state = STATE.ABORTED;
      return encodeFrame(MSG_TYPES.ABORT, encoder.encode(String(reason || 'aborted')));
    }

    _nextNonce() {
      // 12 octets : [senderId:1][counter:11]
      // Limite à 2^32-1 : les opérateurs >>> JS sont 32-bit, au-delà les octets
      // hauts seraient corrompus et causeraient des collisions de nonce GCM.
      if (this.sendCounter >= 0xFFFFFFFF) {
        throw new Error('Nonce counter overflow — la session doit être redémarrée');
      }
      const nonce = new Uint8Array(12);
      nonce[0] = this.senderId & 0xff;
      const c = ++this.sendCounter;
      for (let i = 11; i >= 1 && c > 0; i--) {
        nonce[i] = (c >>> ((11 - i) * 8)) & 0xff;
      }
      return nonce;
    }
  }

  return { PCTPSession, STATE, SAS_DICT, bytesToSAS };
});
