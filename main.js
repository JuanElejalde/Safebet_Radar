const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const screenshot = require('screenshot-desktop');
const { parsearTexto, leerRegion, ColaOportunidades, calcularCobertura, resolverDeepLink } = require('./radar-engine');

// ------------------------------------------------------------------
// CONFIGURACIÓN FIJA DE NAVEGADOR/PERFIL POR CASA
// Edita estos valores directamente aquí si cambian tus rutas o perfiles.
// ------------------------------------------------------------------
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PERFILES_POR_CASA = {
  pinnacle: 'Profile 4',
  betplay: 'Profile 3',
  unibet: 'Profile 3',
};

function abrirEnChromeConPerfil(url, casa) {
  const perfil = PERFILES_POR_CASA[casa.toLowerCase()];

  if (!perfil || !fs.existsSync(CHROME_PATH)) {
    shell.openExternal(url);
    return;
  }

  execFile(CHROME_PATH, [`--profile-directory=${perfil}`, url], (err) => {
    if (err) shell.openExternal(url);
  });
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'safebet-radar-config.json');
const INTERVALO_MS = 1500;

let mainWindow = null;
let overlayWindow = null;
let cola = new ColaOportunidades();
let intervaloActivo = null;
let config = cargarConfig();

function cargarConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { region: null, screenId: null }; // sin calibrar todavía
  }
}

function guardarConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 400,
    minHeight: 500,
    title: 'SafeBet Radar',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('config-inicial', {
      calibrado: !!config.region,
      region: config.region,
    });
  });
}

// ------------------------------------------------------------------
// CALIBRACIÓN: overlay transparente de pantalla completa para
// que el usuario arrastre el rectángulo sobre el bloque de cuotas
// ------------------------------------------------------------------
async function abrirOverlayCalibracion(indice) {
  const monitores = await obtenerMonitoresCombinados();
  const monitor = monitores[indice] || monitores[0];

  overlayWindow = new BrowserWindow({
    x: monitor.bounds.x,
    y: monitor.bounds.y,
    width: monitor.bounds.width,
    height: monitor.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'public', 'overlay.html'));
  overlayWindow.webContents.on('did-finish-load', () => {
    // Le mandamos el captureId REAL (de screenshot-desktop), no el índice
    overlayWindow.webContents.send('overlay-display-info', { captureId: monitor.captureId });
  });
}

ipcMain.on('iniciar-calibracion', (event, indice) => {
  abrirOverlayCalibracion(indice);
});

// ------------------------------------------------------------------
// Lista de monitores: usamos los IDs propios de screenshot-desktop
// (que es lo que realmente usaremos para capturar), correlacionados
// por orden con los bounds de Electron (que necesitamos para
// posicionar la ventana de calibración en el lugar correcto)
// ------------------------------------------------------------------
async function obtenerMonitoresCombinados() {
  const pantallasCaptura = await screenshot.listDisplays(); // IDs reales para capturar
  const pantallasElectron = screen.getAllDisplays();         // bounds reales para posicionar

  // Asumimos mismo orden de enumeración entre ambas librerías
  // (válido en la gran mayoría de casos con 2 monitores)
  return pantallasCaptura.map((pc, i) => {
    const pe = pantallasElectron[i] || pantallasElectron[0];
    return {
      captureId: pc.id,
      bounds: pe.bounds,
      primary: pe.id === screen.getPrimaryDisplay().id,
      label: `${pe.bounds.width}x${pe.bounds.height} (${pe.bounds.x}, ${pe.bounds.y})`,
    };
  });
}

ipcMain.on('listar-monitores', async (event) => {
  const monitores = await obtenerMonitoresCombinados();
  const paraEnviar = monitores.map((m, i) => ({
    id: i, // índice simple para que la interfaz elija, no ambiguo
    label: m.label,
    primary: m.primary,
  }));
  event.sender.send('lista-monitores', paraEnviar);
});

// El overlay reporta la región seleccionada + el captureId real de screenshot-desktop
ipcMain.on('region-calibrada', (event, { region, captureId }) => {
  config.region = region;
  config.screenId = captureId;
  guardarConfig();

  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }

  if (mainWindow) {
    mainWindow.webContents.send('calibracion-completa', { region });
  }
});

ipcMain.on('cancelar-calibracion', () => {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
});

// ------------------------------------------------------------------
// LOOP DE CAPTURA
// ------------------------------------------------------------------
async function cicloLectura() {
  if (!config.region) return;
  try {
    const { texto } = await leerRegion(config.region, config.screenId);
    const detectadas = parsearTexto(texto);
    const eventos = cola.actualizar(detectadas);

    if (mainWindow) {
      mainWindow.webContents.send('actualizacion-cola', {
        items: cola.listar(),
        eventos,
        textoCrudo: texto,
      });
    }
  } catch (err) {
    if (mainWindow) mainWindow.webContents.send('error-radar', err.message);
  }
}

ipcMain.on('iniciar-radar', () => {
  if (!config.region) return;
  if (intervaloActivo) clearInterval(intervaloActivo);
  cicloLectura();
  intervaloActivo = setInterval(cicloLectura, INTERVALO_MS);
});

ipcMain.on('limpiar-historial', () => {
  cola = new ColaOportunidades();
  if (mainWindow) {
    mainWindow.webContents.send('actualizacion-cola', { items: [], eventos: [] });
  }
});

ipcMain.on('detener-radar', () => {
  if (intervaloActivo) {
    clearInterval(intervaloActivo);
    intervaloActivo = null;
  }
});

ipcMain.on('verificar-partido', async (event, { clave }) => {
  const item = cola.items.get(clave);
  if (!item) {
    event.sender.send('resultado-verificacion', { clave, error: 'No encontrado' });
    return;
  }

  event.sender.send('resultado-verificacion', { clave, cargando: true });

  const url = await resolverDeepLink(item.casa, item.partido);

  if (url) {
    abrirEnChromeConPerfil(url, item.casa);
    event.sender.send('resultado-verificacion', { clave, url });
  } else {
    event.sender.send('resultado-verificacion', { clave, error: 'No se encontró el partido' });
  }
});

ipcMain.on('calcular-cobertura', (event, { clave1, clave2, monto }) => {
  const item1 = cola.items.get(clave1);
  const item2 = cola.items.get(clave2);
  if (!item1 || !item2) {
    event.sender.send('resultado-cobertura', { error: 'Selección inválida' });
    return;
  }
  const resultado = calcularCobertura(item1.cuota, item2.cuota, monto);
  event.sender.send('resultado-cobertura', { resultado, item1, item2 });
});

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (intervaloActivo) clearInterval(intervaloActivo);
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
