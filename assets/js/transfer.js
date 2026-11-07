/**
 * transfer.js — Logique frontend de la page de transfert par câble (PCTP).
 *
 * Appelle les IPC channels suivants (exposés via preload.js → window.passory.transfer) :
 *   pctp:listen    → démarre un serveur TCP localhost:47821, retourne immédiatement
 *   pctp:connect   → se connecte à host:47821
 *   pctp:sas-confirm  → l'utilisateur a validé visuellement la SAS
 *   pctp:cancel    → annule la session en cours
 *   pctp:transfer  → envoie les items sélectionnés (sender uniquement)
 *   pctp:save-received → demande au main de persister les items reçus dans le coffre
 *
 * Événements reçus du main via ipcRenderer.on (exposés comme callbacks) :
 *   pctp:event  → { type, ...payload }
 *     types : 'connected' | 'sas-ready' | 'peer-confirmed-sas' | 'ready'
 *             | 'transfer-started' | 'item-received' | 'items-received'
 *             | 'done' | 'error' | 'aborted'
 */
(function () {
  'use strict';

  // Fonction désactivée en v1.0 (src/shared/features.js) : common.js renvoie
  // déjà à l'accueil, on n'initialise rien.
  if (!(window.PassoryFeatures && window.PassoryFeatures.transfer)) return;

  // ── Refs DOM ────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  // Tabs
  const tabSend    = $('tab-send');
  const tabReceive = $('tab-receive');
  const panelSend  = $('panel-send');
  const panelRecv  = $('panel-receive');

  // Send panel
  const sendDot            = $('send-dot');
  const sendStatusText     = $('send-status-text');
  const sendSasSection     = $('send-sas-section');
  const sendSasCode        = $('send-sas-code');
  const sendSasConfirm     = $('send-sas-confirm');
  const sendSasReject      = $('send-sas-reject');
  const sendItemsSection   = $('send-items-section');
  const sendItemSearch     = $('send-item-search');
  const sendItemList       = $('send-item-list');
  const sendCountHint      = $('send-count-hint');
  const sendProgressSec    = $('send-progress-section');
  const sendProgressFill   = $('send-progress-fill');
  const sendProgressLabel  = $('send-progress-label');
  const sendProgressTrack  = $('send-progress-track');
  const sendStartBtn       = $('send-start-btn');
  const sendCancelBtn      = $('send-cancel-btn');

  // Receive panel
  const recvDot            = $('recv-dot');
  const recvStatusText     = $('recv-status-text');
  const recvHostInput      = $('recv-host-input');
  const recvHostGroup      = $('recv-host-group');
  const recvSasSection     = $('recv-sas-section');
  const recvSasCode        = $('recv-sas-code');
  const recvSasConfirm     = $('recv-sas-confirm');
  const recvSasReject      = $('recv-sas-reject');
  const recvProgressSec    = $('recv-progress-section');
  const recvProgressFill   = $('recv-progress-fill');
  const recvProgressLabel  = $('recv-progress-label');
  const recvProgressTrack  = $('recv-progress-track');
  const recvReceivedSec    = $('recv-received-section');
  const recvReceivedList   = $('recv-received-list');
  const recvConnectBtn     = $('recv-connect-btn');
  const recvCancelBtn      = $('recv-cancel-btn');

  // Boutons de sélection
  const sendSelectAll   = $('send-select-all');
  const sendDeselectAll = $('send-deselect-all');

  // ── État local ──────────────────────────────────────────────────────────
  let allEntries   = [];   // { id, label, username, url }
  let activeMode   = 'send'; // 'send' | 'receive'
  let sessionActive = false;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function show(el)  { el && el.classList.remove('section-hidden'); }
  function hide(el)  { el && el.classList.add('section-hidden'); }

  function setStatus(dot, text, state, message) {
    dot.className = 'status-dot ' + state; // waiting | connecting | connected | error
    text.textContent = message;
  }

  function setProgress(fill, track, label, done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    fill.style.width = pct + '%';
    track.setAttribute('aria-valuenow', pct);
    label.textContent = done + ' / ' + (total || '?');
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (window.Passory && window.Passory.toast) window.Passory.toast(msg, kind || 'info');
  }

  // ── Chargement des items ─────────────────────────────────────────────────

  async function loadEntries() {
    if (!window.passory || !window.passory.items) return;
    try {
      const res = await window.passory.items.list('password');
      if (!res.success) {
        if (res.error === 'LOCKED') { window.Passory && window.Passory.lockAndGoLogin(); return; }
        toast(window.Passory.friendlyError(res, 'Impossible d\'afficher vos mots de passe.'), 'error');
        return;
      }
      allEntries = (res.entries || []).map((e) => ({
        id:       e.id,
        label:    e.payload ? e.payload.label    || '' : '',
        username: e.payload ? e.payload.username || '' : '',
        url:      e.payload ? e.payload.url      || '' : '',
      }));
      renderItemList();
    } catch (err) {
      toast('Impossible d\'afficher vos mots de passe. Verrouillez puis rouvrez le coffre.', 'error');
    }
  }

  function getCheckedIds() {
    return Array.from(sendItemList.querySelectorAll('input[type="checkbox"]:checked'))
      .map((cb) => cb.value);
  }

  function renderItemList() {
    const q = (sendItemSearch.value || '').trim().toLowerCase();
    const filtered = q
      ? allEntries.filter((e) =>
          e.label.toLowerCase().includes(q) ||
          e.username.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q))
      : allEntries.slice();

    sendItemList.innerHTML = '';

    if (filtered.length === 0) {
      sendItemList.innerHTML =
        '<p style="color:var(--text-muted);font-size:0.8125rem;padding:12px 4px;">' +
        (allEntries.length === 0 ? 'Aucun mot de passe dans le coffre.' : 'Aucun résultat pour cette recherche.') +
        '</p>';
      updateCountHint();
      return;
    }

    for (const e of filtered) {
      const label = document.createElement('label');
      label.className = 'item-check-row';
      label.setAttribute('role', 'listitem');
      // Lier explicitement le label au checkbox (accessibilité)
      const cbId = 'chk-' + e.id;
      label.setAttribute('for', cbId);

      const avatar = window.Passory && window.Passory.renderAvatar
        ? window.Passory.renderAvatar(e.label)
        : '<div class="item-avatar">' + esc(e.label[0] || '?') + '</div>';

      const hostname = (() => {
        try {
          const s = e.url ? (e.url.startsWith('http') ? e.url : 'https://' + e.url) : '';
          return s ? new URL(s).hostname : '';
        } catch { return ''; }
      })();

      label.innerHTML = `
        <input type="checkbox" id="${esc(cbId)}" value="${esc(e.id)}"
               aria-label="Sélectionner ${esc(e.label)}" />
        ${avatar}
        <div class="item-info">
          <div class="item-label">${esc(e.label)}</div>
          <div class="item-sub">${e.username ? esc(e.username) : ''}${e.username && hostname ? ' · ' : ''}${hostname ? esc(hostname) : ''}</div>
        </div>
      `;
      label.querySelector('input').addEventListener('change', updateCountHint);
      sendItemList.appendChild(label);
    }
    updateCountHint();
  }

  function updateCountHint() {
    const n = getCheckedIds().length;
    sendCountHint.textContent = n === 0 ? 'Aucun mot de passe sélectionné' : n + ' mot' + (n > 1 ? 's' : '') + ' de passe sélectionné' + (n > 1 ? 's' : '');
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────

  function switchTab(mode) {
    activeMode = mode;
    const isSend = mode === 'send';

    tabSend.classList.toggle('active', isSend);
    tabSend.setAttribute('aria-selected', String(isSend));
    tabReceive.classList.toggle('active', !isSend);
    tabReceive.setAttribute('aria-selected', String(!isSend));

    if (isSend) { show(panelSend); hide(panelRecv); }
    else        { hide(panelSend); show(panelRecv); }
  }

  tabSend.addEventListener('click',    () => switchTab('send'));
  tabReceive.addEventListener('click', () => switchTab('receive'));

  // ── Sélection tout / rien ────────────────────────────────────────────────

  sendSelectAll.addEventListener('click', () => {
    sendItemList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
    updateCountHint();
  });
  sendDeselectAll.addEventListener('click', () => {
    sendItemList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    updateCountHint();
  });

  sendItemSearch.addEventListener('input', renderItemList);

  // ── ENVOYER — démarrer l'écoute ──────────────────────────────────────────

  sendStartBtn.addEventListener('click', async () => {
    const ids = getCheckedIds();
    if (ids.length === 0) {
      toast('Sélectionnez au moins un mot de passe à envoyer.', 'warn');
      return;
    }
    if (!window.passory || !window.passory.transfer) {
      toast('Le transfert direct n\'est pas disponible sur cet appareil. Utilisez une sauvegarde (Paramètres › Sauvegarde).', 'error');
      return;
    }

    sessionActive = true;
    hide(sendStartBtn);
    show(sendCancelBtn);
    setStatus(sendDot, sendStatusText, 'connecting', 'En attente de l\'autre appareil… Cliquez maintenant sur « Se connecter » de l\'autre côté.');

    try {
      const res = await window.passory.transfer.listen();
      if (!res.success) {
        resetSendUI();
        toast(/EADDRINUSE/.test(String(res.error)) ? 'Un autre transfert est déjà en attente sur cet ordinateur. Fermez-le puis réessayez.' : 'Impossible de préparer le transfert. Réessayez ou utilisez une sauvegarde.', 'error');
      }
      // Succès : on attend les événements pctp:event
    } catch (err) {
      resetSendUI();
      toast('Le transfert n\'a pas pu démarrer. Réessayez ou utilisez une sauvegarde.', 'error');
    }
  });

  // ── ENVOYER — valider SAS ────────────────────────────────────────────────

  sendSasConfirm.addEventListener('click', async () => {
    sendSasConfirm.disabled = true;
    try {
      await window.passory.transfer.sasConfirm();
      setStatus(sendDot, sendStatusText, 'connected', 'Confirmé — en attente de la confirmation de l\'autre appareil…');
    } catch (err) {
      toast('La confirmation a échoué. Annulez et recommencez le transfert.', 'error');
      sendSasConfirm.disabled = false;
    }
  });

  sendSasReject.addEventListener('click', () => cancelSession());

  // ── RECEVOIR — se connecter ──────────────────────────────────────────────

  recvConnectBtn.addEventListener('click', async () => {
    const host = (recvHostInput.value || '127.0.0.1').trim();
    if (!host) {
      toast('Adresse de connexion manquante.', 'warn');
      recvHostInput.focus();
      return;
    }
    if (!window.passory || !window.passory.transfer) {
      toast('Le transfert direct n\'est pas disponible sur cet appareil. Utilisez une sauvegarde (Paramètres › Sauvegarde).', 'error');
      return;
    }

    sessionActive = true;
    hide(recvConnectBtn);
    show(recvCancelBtn);
    hide(recvHostGroup);
    setStatus(recvDot, recvStatusText, 'connecting', 'Connexion à l\'autre appareil…');

    try {
      const res = await window.passory.transfer.connect({ host });
      if (!res.success) {
        resetRecvUI();
        toast('Aucun appareil trouvé. Vérifiez le câble et que l\'autre appareil a bien cliqué sur « Attendre l\'autre appareil », puis réessayez.', 'error');
      }
    } catch (err) {
      resetRecvUI();
      toast('Le transfert n\'a pas pu démarrer. Réessayez ou utilisez une sauvegarde.', 'error');
    }
  });

  // ── RECEVOIR — valider SAS ───────────────────────────────────────────────

  recvSasConfirm.addEventListener('click', async () => {
    recvSasConfirm.disabled = true;
    try {
      await window.passory.transfer.sasConfirm();
      setStatus(recvDot, recvStatusText, 'connected', 'Confirmé — en attente des mots de passe…');
    } catch (err) {
      toast('La confirmation a échoué. Annulez et recommencez le transfert.', 'error');
      recvSasConfirm.disabled = false;
    }
  });

  recvSasReject.addEventListener('click', () => cancelSession());

  // ── Annuler ──────────────────────────────────────────────────────────────

  sendCancelBtn.addEventListener('click', () => cancelSession());
  recvCancelBtn.addEventListener('click', () => cancelSession());

  async function cancelSession() {
    if (!sessionActive) return;
    try {
      if (window.passory && window.passory.transfer) {
        await window.passory.transfer.cancel();
      }
    } catch {}
    resetSendUI();
    resetRecvUI();
    toast('Transfert annulé.', 'warn');
  }

  // ── Remise à zéro des UIs ────────────────────────────────────────────────

  function resetSendUI() {
    sessionActive = false;
    show(sendStartBtn);
    hide(sendCancelBtn);
    hide(sendSasSection);
    hide(sendProgressSec);
    sendSasConfirm.disabled = false;
    setStatus(sendDot, sendStatusText, 'waiting', 'Prêt — choisissez les mots de passe puis cliquez sur « Attendre l\'autre appareil »');
    setProgress(sendProgressFill, sendProgressTrack, sendProgressLabel, 0, 0);
  }

  function resetRecvUI() {
    sessionActive = false;
    show(recvConnectBtn);
    hide(recvCancelBtn);
    show(recvHostGroup);
    hide(recvSasSection);
    hide(recvProgressSec);
    recvSasConfirm.disabled = false;
    setStatus(recvDot, recvStatusText, 'waiting', 'Prêt — lancez d\'abord l\'envoi sur l\'autre appareil');
    setProgress(recvProgressFill, recvProgressTrack, recvProgressLabel, 0, 0);
  }

  // ── Réception des événements PCTP depuis le main ─────────────────────────

  function handlePCTPEvent(ev) {
    const { type } = ev;

    switch (type) {

      case 'connected':
        if (activeMode === 'send') {
          setStatus(sendDot, sendStatusText, 'connecting', 'Appareil connecté — sécurisation de la connexion…');
        } else {
          setStatus(recvDot, recvStatusText, 'connecting', 'Connecté — sécurisation de la connexion…');
        }
        break;

      case 'sas-ready': {
        const sas = ev.sas || '';
        if (activeMode === 'send') {
          sendSasCode.textContent = sas;
          show(sendSasSection);
          setStatus(sendDot, sendStatusText, 'connecting', 'Comparez le code ci-dessous avec celui de l\'autre appareil');
        } else {
          recvSasCode.textContent = sas;
          show(recvSasSection);
          setStatus(recvDot, recvStatusText, 'connecting', 'Comparez le code ci-dessous avec celui de l\'autre appareil');
        }
        break;
      }

      case 'peer-confirmed-sas':
        if (activeMode === 'send') {
          setStatus(sendDot, sendStatusText, 'connecting', 'L\'autre appareil a confirmé — confirmez aussi ici');
        } else {
          setStatus(recvDot, recvStatusText, 'connecting', 'L\'autre appareil a confirmé — confirmez aussi ici');
        }
        break;

      case 'ready':
        if (activeMode === 'send') {
          setStatus(sendDot, sendStatusText, 'connected', 'Connexion sécurisée — envoi des mots de passe…');
          hide(sendSasSection);
          show(sendProgressSec);
          // Déclenche l'envoi des items sélectionnés
          const ids = getCheckedIds();
          window.passory.transfer.transfer({ ids }).catch((err) => {
            toast('L\'envoi a échoué. Recommencez le transfert.', 'error');
            resetSendUI();
          });
        } else {
          setStatus(recvDot, recvStatusText, 'connected', 'Connexion sécurisée — réception des mots de passe…');
          hide(recvSasSection);
          show(recvProgressSec);
        }
        break;

      case 'transfer-started': {
        const total = ev.count || 0;
        if (activeMode === 'send') {
          setProgress(sendProgressFill, sendProgressTrack, sendProgressLabel, 0, total);
        } else {
          setProgress(recvProgressFill, recvProgressTrack, recvProgressLabel, 0, total);
        }
        break;
      }

      case 'item-received': {
        const { received, total, item } = ev;
        setProgress(recvProgressFill, recvProgressTrack, recvProgressLabel, received, total);
        // Ajoute l'item dans la liste visuelle
        show(recvReceivedSec);
        const el = document.createElement('div');
        el.className = 'received-item';
        el.setAttribute('role', 'listitem');
        el.innerHTML =
          '<i class="fas fa-check-circle" aria-hidden="true"></i>' +
          '<span>' + esc((item && item.label) || 'Élément reçu') + '</span>';
        recvReceivedList.appendChild(el);
        break;
      }

      case 'items-received': {
        const count = ev.count || 0;
        setStatus(recvDot, recvStatusText, 'connected', count + ' mot(s) de passe reçu(s) — enregistrement…');
        // Demande au main de persister les items dans le coffre
        window.passory.transfer.saveReceived()
          .then((res) => {
            if (res && res.success) {
              setStatus(recvDot, recvStatusText, 'connected',
                (res.saved != null ? res.saved : count) + ' item(s) ajouté(s) au coffre avec succès');
              toast((res.saved != null ? res.saved : count) + ' mot(s) de passe importé(s).', 'success');
            } else {
              toast('Les mots de passe reçus n\'ont pas pu être enregistrés. Recommencez le transfert.', 'error');
            }
          })
          .catch(() => toast('Les mots de passe reçus n\'ont pas pu être enregistrés. Recommencez le transfert.', 'error'))
          .finally(() => {
            sessionActive = false;
            show(recvConnectBtn);
            hide(recvCancelBtn);
          });
        break;
      }

      case 'done':
        if (activeMode === 'send') {
          setStatus(sendDot, sendStatusText, 'connected', 'Transfert terminé avec succès.');
          hide(sendProgressSec);
          toast('Transfert réussi.', 'success');
          setTimeout(resetSendUI, 3000);
        }
        break;

      case 'error': {
        const msg = 'Le transfert a été interrompu. Vérifiez le câble puis recommencez.';
        if (ev.message) console.warn('[transfert]', ev.message);
        if (activeMode === 'send') {
          setStatus(sendDot, sendStatusText, 'error', msg);
          resetSendUI();
        } else {
          setStatus(recvDot, recvStatusText, 'error', msg);
          resetRecvUI();
        }
        toast(msg, 'error');
        break;
      }

      case 'aborted': {
        const r = String(ev.reason || '');
        const reason = /utilisateur/.test(r) ? 'annulé sur l\'autre appareil' : /fermée|pair/.test(r) ? 'l\'autre appareil s\'est déconnecté' : 'annulé';
        if (activeMode === 'send') {
          setStatus(sendDot, sendStatusText, 'error', 'Annulé : ' + reason);
          setTimeout(resetSendUI, 2500);
        } else {
          setStatus(recvDot, recvStatusText, 'error', 'Annulé : ' + reason);
          setTimeout(resetRecvUI, 2500);
        }
        toast('Transfert annulé : ' + reason, 'warn');
        break;
      }

      default:
        break;
    }
  }

  // Abonnement aux événements temps-réel émis par le main
  if (window.passory && window.passory.transfer && window.passory.transfer.onEvent) {
    window.passory.transfer.onEvent(handlePCTPEvent);
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    const ok = await window.Passory.requireUnlockedOrRedirect();
    if (!ok) return;
    await loadEntries();
  });

})();
