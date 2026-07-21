const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radarAPI', {
  // Calibración
  listarMonitores: () => ipcRenderer.send('listar-monitores'),
  onListaMonitores: (cb) => ipcRenderer.on('lista-monitores', (e, data) => cb(data)),
  iniciarCalibracion: (displayId) => ipcRenderer.send('iniciar-calibracion', displayId),
  onCalibracionCompleta: (cb) => ipcRenderer.on('calibracion-completa', (e, data) => cb(data)),
  onConfigInicial: (cb) => ipcRenderer.on('config-inicial', (e, data) => cb(data)),

  // Overlay (usado solo desde overlay.html)
  onOverlayDisplayInfo: (cb) => ipcRenderer.on('overlay-display-info', (e, data) => cb(data)),
  reportarRegion: (payload) => ipcRenderer.send('region-calibrada', payload),
  cancelarCalibracion: () => ipcRenderer.send('cancelar-calibracion'),

  // Radar
  iniciarRadar: () => ipcRenderer.send('iniciar-radar'),
  detenerRadar: () => ipcRenderer.send('detener-radar'),
  limpiarHistorial: () => ipcRenderer.send('limpiar-historial'),
  onActualizacionCola: (cb) => ipcRenderer.on('actualizacion-cola', (e, data) => cb(data)),
  onErrorRadar: (cb) => ipcRenderer.on('error-radar', (e, msg) => cb(msg)),

  // Cálculo
  calcularCobertura: (payload) => ipcRenderer.send('calcular-cobertura', payload),
  onResultadoCobertura: (cb) => ipcRenderer.on('resultado-cobertura', (e, data) => cb(data)),

  // Verificación / deep link
  verificarPartido: (clave) => ipcRenderer.send('verificar-partido', { clave }),
  onResultadoVerificacion: (cb) => ipcRenderer.on('resultado-verificacion', (e, data) => cb(data)),
});
