// Simulation minimale des plugins Capacitor (persistance via localStorage).
const LS = window.localStorage;
const fsKey = (p, d) => 'fs:' + d + ':' + p;
const err = (m) => { const e = new Error(m); return e; };
window.Capacitor = {
  getPlatform: () => 'android', isNativePlatform: () => true,
  Plugins: {
    Filesystem: {
      async mkdir() {}, 
      async readFile({ path, directory }) { const v = LS.getItem(fsKey(path, directory)); if (v === null) throw err('File does not exist'); return { data: v }; },
      async writeFile({ path, directory, data }) { LS.setItem(fsKey(path, directory), data); return {}; },
      async deleteFile({ path, directory }) { if (LS.getItem(fsKey(path, directory)) === null) throw err('File does not exist'); LS.removeItem(fsKey(path, directory)); },
      async rename({ from, to, directory }) { const v = LS.getItem(fsKey(from, directory)); if (v === null) throw err('File does not exist'); LS.setItem(fsKey(to, directory), v); LS.removeItem(fsKey(from, directory)); },
      async readdir({ path, directory }) { const pre = fsKey(path + '/', directory); return { files: Object.keys(LS).filter((k) => k.startsWith(pre)).map((k) => ({ name: k.slice(pre.length) })) }; },
      async getUri({ path }) { return { uri: 'file:///cache/' + path }; },
    },
    SecureStorage: {
      async internalGetItem({ prefixedKey }) { return { data: LS.getItem('sec:' + prefixedKey) }; },
      async internalSetItem({ prefixedKey, data }) { LS.setItem('sec:' + prefixedKey, data); },
      async internalRemoveItem({ prefixedKey }) { LS.removeItem('sec:' + prefixedKey); },
    },
    BiometricAuthNative: {
      async internalAuthenticate() { LS.setItem('bioCalls', String(Number(LS.getItem('bioCalls') || 0) + 1)); if (LS.getItem('bioOk') !== '1') throw err('userCancel'); },
    },
    Clipboard: { async write() { LS.setItem('clipPlain', '1'); }, async read() { return { value: '' }; } },
    SensitiveClipboard: {
      async write({ string }) { LS.setItem('clipSensitive', string); },
      async read() { return { value: LS.getItem('clipSensitive') || '' }; },
      async clear() { LS.removeItem('clipSensitive'); },
    },
  },
};
