# 📡 SafeBet Radar — OCR Pipeline para Lectura de Cuotas en Tiempo Real

> **by Juan Elejalde**  
> App de escritorio construida en Electron que captura, procesa y analiza cuotas de casas de apuestas en tiempo real mediante OCR, generando oportunidades de cobertura automáticamente.

---

## 🧠 ¿Cómo funciona?

1. **Captura de pantalla** — toma screenshots de una región definida de la pantalla en tiempo real
2. **Preprocesamiento de imagen** — usa Sharp para escalar, convertir a escala de grises y normalizar la imagen
3. **OCR** — Tesseract lee el texto de las cuotas directamente desde la pantalla
4. **Parser inteligente** — identifica casas de apuestas, partidos, mercados y cuotas con expresiones regulares tolerantes a errores de OCR
5. **Cola de oportunidades** — rastrea el estado de cada oportunidad (nueva, cambio de cuota, fuera de pantalla)
6. **Deep links automáticos** — abre directamente el partido correcto en Pinnacle o BetPlay con un clic

---

## ✨ Funcionalidades

- 📸 Captura y procesamiento de imagen con **Sharp** + **screenshot-desktop**
- 🔤 OCR con **Tesseract** (tolerante a confusiones típicas: 0↔O, 1↔l, 2↔Z)
- 🏦 Detección de casas: **Pinnacle, BetPlay, Unibet, Betano**
- 📊 6 mercados soportados: Team1 Win, Team2 Win, TO, TU, AH1, AH2
- 🔗 Deep links automáticos via:
  - **Pinnacle** — API guest de Arcadia
  - **BetPlay** — API Kambi
- 💰 Calculadora de cobertura integrada (ganancia neta garantizada)
- 🗂️ Cola de oportunidades con estados: `en_pantalla`, `fuera_de_pantalla`, archivado

---

## 🛠️ Tecnologías

- **Electron** — app de escritorio
- **Node.js** — backend y lógica principal
- **Tesseract OCR** (`node-tesseract-ocr`) — reconocimiento de texto
- **Sharp** — procesamiento de imágenes
- **screenshot-desktop** — captura de pantalla
- **Pinnacle Guest API** — resolución de deep links
- **BetPlay / Kambi API** — resolución de deep links

---

## 📁 Estructura
```
safebet-radar-app/
├── main.js # Proceso principal de Electron
├── preload.js # Bridge seguro entre Electron y el frontend
├── radar-engine.js # Motor OCR, parser, cola y deep links
├── package.json # Configuración y dependencias
└── public/
├── index.html # Interfaz principal
└── overlay.html # Overlay de la app
```
---

## 🚀 Instalación

```bash
npm install
npm start
```

---

## ⚠️ Notas

- Betano está excluida del deep link automático por protección Cloudflare anti-bot
- Requiere Tesseract instalado en el sistema
- Diseñada para funcionar con el servicio de cuotas en tiempo real cantacuotas vía Zoom

---

## 👨‍💻 Autor

**Juan Elejalde** — Proyecto real de automatización · Ibagué, Colombia 🇨🇴
