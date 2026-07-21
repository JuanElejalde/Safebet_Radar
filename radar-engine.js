/**
 * MOTOR DEL RADAR — captura, OCR, parser y cola de oportunidades
 * ------------------------------------------------
 * Toda la lógica que ya validamos en las pruebas de consola,
 * empaquetada como módulo reutilizable para la app Electron.
 */

const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const tesseract = require('node-tesseract-ocr');
const fs = require('fs');
const path = require('path');
const https = require('https');

const OCR_CONFIG = { lang: 'eng', oem: 1, psm: 6 };

const CASAS_CONOCIDAS = ['Pinnacle', 'Unibet', 'BetanoCO', 'Betano', 'BetPlay'];
const PATRON_CASA = new RegExp(`\\b(${CASAS_CONOCIDAS.join('|')})\\b`, 'i');
const PATRON_PARTIDO = /^[^\wáéíóúñÁÉÍÓÚÑ]*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9\s()]+?)\s+-\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9\s()]+?)[\s.,_]*$/;

// Encuentra TODOS los números con 2 decimales en la línea (las cuotas suelen
// tener ese formato: "1.60", "2.85", etc.) — nos quedamos con el ÚLTIMO
// que esté en un rango realista de cuota (1.01 a 50), para no confundir
// montos en dinero (ej. límites de apuesta "$550.00") con la cuota real.
const PATRON_CUOTA = /\d+\.\d{2}/g;
const CUOTA_MIN = 1.01;
const CUOTA_MAX = 50;

// Quita cualquier texto inicial que sea solo números/marcadores de set/símbolos,
// hasta la primera letra real (cubre cualquier formato de score sin importar
// cuántos grupos tenga, ej "0:1 (1:6, 1:4) 0:0*")
const PATRON_MARCADOR_INICIAL = /^[\d:.,()\s*]+(?=[A-Za-zÀ-ÿ])/;

// Los ÚNICOS 6 tipos de mercado que se manejan — todo lo demás se descarta.
// Los patrones son tolerantes a confusiones típicas del OCR:
// 0↔O, 1↔l↔I, 2↔Z (para no perder cuotas válidas por un carácter mal leído)
const MERCADOS_PERMITIDOS = [
  { regex: /team\s*[1lI]\s*win/i, formatear: () => 'Team1 Win' },
  { regex: /team\s*[2Z]\s*win/i, formatear: () => 'Team2 Win' },
  { regex: /T[O0]\s*\(?\s*([\d.]+)\s*\)?/i, formatear: (m) => `TO(${m[1]})` },
  { regex: /T[UÜ]\s*\(?\s*([\d.]+)\s*\)?/i, formatear: (m) => `TU(${m[1]})` },
  { regex: /A[HN]\s*[1lI][.:]?\s*\(?\s*([+-]?[\d.]+)\s*\)?/i, formatear: (m) => `AH1(${m[1]})` },
  { regex: /A[HN]\s*[2Z][.:]?\s*\(?\s*([+-]?[\d.]+)\s*\)?/i, formatear: (m) => `AH2(${m[1]})` },
];

// Busca dentro del texto crudo si aparece alguno de los 6 mercados conocidos.
// Devuelve el mercado ya limpio y formateado, o null si no es uno de los 6
// (en cuyo caso esa oportunidad se descarta por completo).
function normalizarMercado(textoRaw) {
  for (const m of MERCADOS_PERMITIDOS) {
    const match = textoRaw.match(m.regex);
    if (match) return m.formatear(match);
  }
  return null;
}

const TIEMPO_ARCHIVO_MS = 5 * 60 * 1000; // 5 minutos fuera de pantalla -> se archiva

function parsearTexto(textoOCR) {
  const lineas = textoOCR.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const oportunidades = [];
  let partidoActual = null;
  let casaActual = null;
  let bufferTexto = '';

  // Cuotas que sobraron en un bloque (más cuotas que mercados) — probablemente
  // pertenecen al SIGUIENTE bloque, porque el OCR a veces "adelanta" un número
  // antes de que aparezca el nombre de la siguiente casa en el texto lineal.
  let cuotasPendientes = [];

  function cerrarBloque() {
    if (!casaActual || !bufferTexto.trim()) return;

    const mercadosEncontrados = [];
    for (const m of MERCADOS_PERMITIDOS) {
      const flags = m.regex.flags.includes('g') ? m.regex.flags : m.regex.flags + 'g';
      const regexGlobal = new RegExp(m.regex.source, flags);
      let match;
      while ((match = regexGlobal.exec(bufferTexto)) !== null) {
        mercadosEncontrados.push({ index: match.index, label: m.formatear(match) });
      }
    }
    mercadosEncontrados.sort((a, b) => a.index - b.index);

    const cuotasDelBloque = [...bufferTexto.matchAll(PATRON_CUOTA)]
      .map(c => ({ index: c.index, valor: parseFloat(c[0]) }))
      .filter(c => c.valor >= CUOTA_MIN && c.valor <= CUOTA_MAX)
      .sort((a, b) => a.index - b.index)
      .map(c => c.valor);

    // Primero usamos cuotas pendientes del bloque anterior (si las hay),
    // y completamos con las de este bloque
    const cuotasDisponibles = [...cuotasPendientes, ...cuotasDelBloque];

    const cantidad = Math.min(mercadosEncontrados.length, cuotasDisponibles.length);
    for (let i = 0; i < cantidad; i++) {
      oportunidades.push({
        casa: casaActual,
        partido: partidoActual || '(no detectado)',
        mercado: mercadosEncontrados[i].label,
        cuota: cuotasDisponibles[i],
      });
    }

    // Lo que sobre (de cualquiera de los dos lados) queda pendiente para el
    // próximo bloque — normalmente serán cuotas sobrantes, no mercados
    cuotasPendientes = cuotasDisponibles.slice(cantidad);
  }

  for (const linea of lineas) {
    const matchCasa = linea.match(PATRON_CASA);

    if (matchCasa) {
      // Nueva casa detectada: cerramos el bloque anterior y arrancamos uno nuevo
      cerrarBloque();
      casaActual = matchCasa[1];
      bufferTexto = linea.replace(matchCasa[0], '').trim();
    } else {
      bufferTexto += ' ' + linea;
    }

    // Independiente del bloque de casa: si esta línea es SOLO el nombre del
    // partido (sin ninguna cuota válida), actualizamos partidoActual
    const lineaSinCasa = matchCasa ? linea.replace(matchCasa[0], '').trim() : linea;
    const matchPartido = lineaSinCasa.match(PATRON_PARTIDO);
    const tieneCuotaValida = [...lineaSinCasa.matchAll(PATRON_CUOTA)]
      .some(c => { const v = parseFloat(c[0]); return v >= CUOTA_MIN && v <= CUOTA_MAX; });

    if (matchPartido && !tieneCuotaValida) {
      partidoActual = `${matchPartido[1].trim()} - ${matchPartido[2].trim()}`;
    }
  }

  cerrarBloque(); // no olvidar el último bloque acumulado

  return oportunidades;
}

async function leerRegion(region, screenId) {
  const opts = { format: 'png' };
  if (screenId !== undefined && screenId !== null) opts.screen = screenId;

  const imgBuffer = await screenshot(opts);

  // Diagnóstico: tamaño real de la captura vs región solicitada
  const metadata = await sharp(imgBuffer).metadata();
  console.log(`[DEBUG] Captura completa: ${metadata.width}x${metadata.height}`);
  console.log(`[DEBUG] Región solicitada: left=${region.left}, top=${region.top}, width=${region.width}, height=${region.height}`);

  // Guardamos la captura de pantalla COMPLETA sin recortar, para poder
  // verificar si el problema es la posición del recorte o algo previo
  fs.writeFileSync(path.join(__dirname, 'debug-pantalla-completa.png'), imgBuffer);

  const procesada = await sharp(imgBuffer)
    .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
    .resize({ width: region.width * 3 })
    .grayscale()
    .normalize()
    .toBuffer();

  fs.writeFileSync(path.join(__dirname, 'debug-region-recortada.png'), procesada);

  const texto = await tesseract.recognize(procesada, OCR_CONFIG);
  return { texto, imagenBuffer: procesada };
}

// ------------------------------------------------------------------
// Clase Cola: mantiene el estado de oportunidades entre ciclos
// ------------------------------------------------------------------
class ColaOportunidades {
  constructor() {
    this.items = new Map();
  }

  claveDe(op) {
    return `${op.casa}|${op.partido}|${op.mercado}`;
  }

  actualizar(oportunidadesDetectadas) {
    const ahora = Date.now();
    const clavesVistas = new Set();
    const eventos = [];

    for (const op of oportunidadesDetectadas) {
      const clave = this.claveDe(op);
      clavesVistas.add(clave);
      const existente = this.items.get(clave);

      if (!existente) {
        this.items.set(clave, {
          ...op,
          id: clave,
          estado: 'en_pantalla',
          primeraVez: ahora,
          ultimaVez: ahora,
          cuotaAnterior: null,
        });
        eventos.push({ tipo: 'NUEVA', clave });
      } else {
        const cuotaCambio = existente.cuota !== op.cuota;
        if (cuotaCambio) existente.cuotaAnterior = existente.cuota;
        existente.cuota = op.cuota;
        existente.ultimaVez = ahora;
        if (existente.estado === 'fuera_de_pantalla') eventos.push({ tipo: 'REAPARECIO', clave });
        else if (cuotaCambio) eventos.push({ tipo: 'CUOTA_CAMBIO', clave });
        existente.estado = 'en_pantalla';
      }
    }

    for (const [clave, item] of this.items.entries()) {
      if (!clavesVistas.has(clave) && item.estado === 'en_pantalla') {
        item.estado = 'fuera_de_pantalla';
        item.salioDePantalla = ahora;
        eventos.push({ tipo: 'SALIO_DE_PANTALLA', clave });
      }
    }

    for (const [clave, item] of this.items.entries()) {
      if (item.estado === 'fuera_de_pantalla' && ahora - item.salioDePantalla > TIEMPO_ARCHIVO_MS) {
        this.items.delete(clave);
      }
    }

    return eventos;
  }

  listar() {
    return [...this.items.values()].sort((a, b) => b.ultimaVez - a.ultimaVez);
  }
}

function calcularCobertura(cuota1, cuota2, monto) {
  const montoContra = (monto * cuota1) / cuota2;
  const total = monto + montoContra;
  const retorno = monto * cuota1;
  const neto = retorno - total;
  return {
    montoPata1: monto,
    montoPata2: Math.round(montoContra),
    totalInvertido: Math.round(total),
    retornoGarantizado: Math.round(retorno),
    gananciaNeta: Math.round(neto),
    porcentaje: total > 0 ? ((neto / total) * 100).toFixed(2) : '0.00',
  };
}

// ------------------------------------------------------------------
// RESOLVERS — deep links a Pinnacle y BetPlay (Betano queda excluido:
// su búsqueda está protegida contra peticiones automatizadas)
// ------------------------------------------------------------------

function httpGetJSON(hostname, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path: urlPath, method: 'GET', headers };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function normalizarTexto(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function slugify(texto) {
  return texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// --- Pinnacle ---
const PINNACLE_HOST = 'guest.api.arcadia.zanyzoomwebsite.website';
const PINNACLE_SITE = 'https://www.zanyzoomwebsite.website';
const PINNACLE_API_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

async function resolverPinnacle(nombrePartido, rivalEsperado) {
  const primerEquipo = nombrePartido.split(' - ')[0].trim();
  const path = `/0.1/matchups/search?query=${encodeURIComponent(primerEquipo)}`;
  const resultados = await httpGetJSON(PINNACLE_HOST, path, {
    'Accept': 'application/json',
    'X-Api-Key': PINNACLE_API_KEY,
    'X-Device-Uuid': 'safebet-radar-0000-0000-000000000000',
    'Origin': PINNACLE_SITE,
  });

  const candidatos = resultados.filter(r => r.hasMarkets && r.type === 'matchup');
  const rivalNorm = rivalEsperado ? normalizarTexto(rivalEsperado) : null;

  const match = candidatos.find(r => {
    if (!rivalNorm) return true;
    return r.participants.some(p => normalizarTexto(p.name).includes(rivalNorm));
  });

  if (!match) return null;

  const deporte = slugify(match.league.sport.name);
  const liga = slugify(match.league.name);
  const equipos = match.participants.sort((a, b) => a.order - b.order).map(p => slugify(p.name)).join('-vs-');
  return `${PINNACLE_SITE}/es/${deporte}/${liga}/${equipos}/${match.id}/`;
}

// --- BetPlay (vía Kambi) ---
const KAMBI_HOST = 'us.offering-api.kambicdn.com';
const BETPLAY_SITE = 'https://betplay.com.co';

async function buscarTermKeyBetPlay(nombreEquipo) {
  const path = `/offering/v2018/betplay/term/search.json?lang=es_CO&market=CO&client_id=200&channel_id=1&term=${encodeURIComponent(nombreEquipo)}`;
  const data = await httpGetJSON(KAMBI_HOST, path, { 'Accept': 'application/json', 'Origin': BETPLAY_SITE, 'Referer': BETPLAY_SITE + '/' });
  return (data.resultTerms || []).filter(t => t.type === 'PARTICIPANT');
}

// Categorías de deporte a probar en BetPlay/Kambi, en este orden, hasta
// encontrar una que tenga eventos para el equipo buscado
const DEPORTES_BETPLAY = ['football', 'esports', 'tennis', 'basketball', 'icehockey', 'tabletennis'];

async function resolverBetPlay(nombrePartido, rivalEsperado) {
  const primerEquipo = nombrePartido.split(' - ')[0].trim();
  const candidatosTerm = await buscarTermKeyBetPlay(primerEquipo);
  const rivalNorm = rivalEsperado ? normalizarTexto(rivalEsperado) : null;

  for (const candidato of candidatosTerm) {
    for (const deporte of DEPORTES_BETPLAY) {
      const path = `/offering/v2018/betplay/listView/${deporte}/all/all/${candidato.termKey}.json?channel_id=1&client_id=200&lang=es_CO&market=CO&useCombined=true&useCombinedLive=true`;
      let data;
      try {
        data = await httpGetJSON(KAMBI_HOST, path, { 'Accept': '*/*', 'Origin': BETPLAY_SITE, 'Referer': BETPLAY_SITE + '/' });
      } catch {
        continue; // esta categoría no aplica para este equipo, probamos la siguiente
      }
      const eventos = data.events || [];
      if (eventos.length === 0) continue;

      const match = eventos.find(e => {
        if (!rivalNorm) return e.event.state === 'STARTED';
        const coincideRival = normalizarTexto(e.event.homeName).includes(rivalNorm) || normalizarTexto(e.event.awayName).includes(rivalNorm);
        return coincideRival;
      });

      if (match) return `${BETPLAY_SITE}/apuestas#event/live/${match.event.id}`;
    }
  }

  return null;
}

// Función unificada: intenta resolver según la casa
async function resolverDeepLink(casa, nombrePartido) {
  const [equipo1, equipo2] = nombrePartido.split(' - ').map(s => s.trim());

  try {
    if (/pinnacle/i.test(casa)) {
      return await resolverPinnacle(nombrePartido, equipo2);
    }
    if (/betplay|unibet/i.test(casa)) {
      return await resolverBetPlay(nombrePartido, equipo2);
    }
    return null; // Betano u otra casa no soportada para deep link automático
  } catch (err) {
    console.error(`[resolverDeepLink] Error buscando "${nombrePartido}" en ${casa}:`, err.message);
    return null;
  }
}

module.exports = { parsearTexto, leerRegion, ColaOportunidades, calcularCobertura, resolverDeepLink };
