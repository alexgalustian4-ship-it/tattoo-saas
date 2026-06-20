'use strict';

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execFile } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Bootstrap Higgsfield CLI credentials from env vars ──
function writeCredentials(access, refresh) {
  const credDir  = path.join(os.homedir(), '.config', 'higgsfield');
  const credFile = path.join(credDir, 'credentials.json');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ access_token: access, refresh_token: refresh || '' }));
  return credFile;
}

async function bootstrapHiggsfieldAuth() {
  const access  = process.env.HIGGSFIELD_API_KEY;
  const refresh = process.env.HIGGSFIELD_REFRESH_TOKEN || '';
  if (!access) { console.warn('⚠ HIGGSFIELD_API_KEY not set — generation will fail'); return; }

  writeCredentials(access, refresh);
  console.log('✓ Higgsfield credentials written. HOME =', os.homedir(), '| token prefix =', access.slice(0, 8));

  // Rafraîchit le token immédiatement au démarrage
  if (refresh) {
    try {
      const r = await fetch('https://api.higgsfield.ai/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      const d = await r.json();
      if (d.access_token) {
        writeCredentials(d.access_token, d.refresh_token || refresh);
        console.log('✓ Token refreshed at startup, new prefix =', d.access_token.slice(0, 8));
      } else {
        console.warn('⚠ Refresh response:', JSON.stringify(d).slice(0, 200));
      }
    } catch (e) {
      console.warn('⚠ Startup token refresh failed:', e.message);
    }
  }
}

bootstrapHiggsfieldAuth();

// ─────────────────────────────────────────────────
// Recettes de style — une par style de tatouage.
// ─────────────────────────────────────────────────
const STYLE_RECIPES = {
  concept:
    `Concept tattoo design composition in black and grey realism: ` +
    `the main subject surrounded by fine geometric construction lines, circles, and architectural elements ` +
    `(gothic cathedral rosette, greco-roman structures, or classical architecture) in the background. ` +
    `Faint handwritten script and blueprint-style markings floating around the composition. ` +
    `Subtle fine-line geometric accents and dots. ` +
    `Predominantly black and grey with occasional minimal red accents.`,

  baroque:
    `Baroque tattoo composition: dramatic chiaroscuro with deep shadows and brilliant highlights ` +
    `in the style of Caravaggio and the Italian masters. ` +
    `Ornate decorative elements — acanthus scrolls, cherubs, laurel wreaths, gilded ornaments. ` +
    `Grand architectural details: columns, arches, cathedral vaults. ` +
    `Dynamic diagonal composition, theatrical and grandiose. ` +
    `High contrast black and grey, luxurious and imposing.`,

  japonais:
    `Traditional Japanese irezumi tattoo composition. ` +
    `Bold confident outlines in the woodblock print tradition of Utagawa Kuniyoshi. ` +
    `Decorative wind bars (kaze), stylized clouds (kumo), crashing waves (nami). ` +
    `Strong use of negative space, fluid movement throughout the composition. ` +
    `Black and grey with classic Japanese flat shading and bold outlines.`,

  geometrique:
    `Sacred geometry tattoo composition. ` +
    `Precise geometric patterns: mandalas, Flower of Life, Metatron's Cube, platonic solids. ` +
    `Fine dotwork and single-needle linework. Perfectly symmetrical and mathematically precise. ` +
    `Black and grey, clean white negative space, no gradients — only linework and dots. ` +
    `Architectural precision meeting spiritual sacred geometry.`,

  realisme:
    `Hyperrealistic black and grey tattoo composition. ` +
    `Photorealistic detail with precise rendering of every texture: skin, fur, feather, metal, stone. ` +
    `Deep contrasts between pure black shadows and brilliant white highlights. ` +
    `Dramatic studio lighting, photographic quality. ` +
    `Fine detail work, every element rendered with anatomical and material accuracy.`,
};

// ─────────────────────────────────────────────────
// Modificateurs d'ambiance
// ─────────────────────────────────────────────────
const AMBIANCE_MODIFIERS = {
  sombre:
    `Atmosphere: dark and brooding. Heavy blacks, deep shadows, ominous gothic mood.`,
  epique:
    `Atmosphere: epic and grand. Heroic scale, powerful composition, cinematic grandeur.`,
  religieux:
    `Atmosphere: sacred and divine. Celestial light rays, spiritual symbolism, transcendent reverence.`,
  doux:
    `Atmosphere: soft and delicate. Gentle gradients, flowing elegant lines, serene and peaceful.`,
  mystique:
    `Atmosphere: mysterious and esoteric. Occult symbolism, ancient mysticism, enigmatic and otherworldly.`,
  guerrier:
    `Atmosphere: fierce warrior spirit. Battle-ready energy, dynamic power, aggressive and commanding.`,
};

const TECHNICAL_REQUIREMENTS =
  `TECHNICAL REQUIREMENTS: flat digital artwork, perfectly centered, filling the full frame, ` +
  `pure solid white background (#FFFFFF), no paper texture, no paper shadows, no drop shadows, ` +
  `no perspective tilt, no photographic effect, no mockup, no surface, no desk, ` +
  `not a photograph of paper, strictly 2D flat composition.`;

// ─────────────────────────────────────────────────
// Format/composition par zone — étape 1
// ─────────────────────────────────────────────────
const ZONE_COMPOSITION = {
  'avant-bras':
    `Canvas format: tall narrow vertical composition (approximately 1:3 width-to-height ratio), ` +
    `designed to run from wrist to elbow along the forearm.`,

  'bras-complet':
    `Canvas format: long full-sleeve vertical composition (approximately 1:5 width-to-height ratio), ` +
    `continuous flow from shoulder down to wrist.`,

  'epaule':
    `Canvas format: compact rounded composition centered on the deltoid shoulder, ` +
    `bold central motif with semi-circular or shield-shaped framing.`,

  'dos':
    `Canvas format: large wide vertical composition filling the entire back canvas, ` +
    `bold and imposing, centered on a vertical spine axis spreading across both shoulder blades.`,

  'pectoral':
    `Canvas format: horizontal medium-format composition (wider than tall), ` +
    `following the natural arc of the chest muscle.`,

  'cuisse':
    `Canvas format: tall vertical composition (approximately 1:2.5 width-to-height ratio), ` +
    `designed to run along the outer thigh from above the knee toward the hip.`,

  'mollet':
    `Canvas format: compact vertical composition (approximately 1:2 width-to-height ratio), ` +
    `centered on the calf muscle from ankle to back of knee.`,

  'main':
    `Canvas format: small compact square-ish composition adapted for the hand, ` +
    `bold simple shapes with minimal fine detail to remain legible at small scale.`,
};

function buildPrompt({ sujet, style = 'concept', ambiance = 'epique', mot = '', elements = '', zone = '', withReference = false }) {
  const recipe   = STYLE_RECIPES[style]        || STYLE_RECIPES.concept;
  const mood     = AMBIANCE_MODIFIERS[ambiance] || AMBIANCE_MODIFIERS.epique;
  const zonePart = ZONE_COMPOSITION[zone]       || '';
  const refPart  = withReference
    ? `Draw strong inspiration from the provided reference image for the overall composition and visual approach, while keeping the subject, chosen style, and atmosphere described below.`
    : '';
  const motPart =
    mot.trim()
      ? `The word or text "${mot.trim()}" must be elegantly integrated as tattoo lettering into the composition.`
      : '';
  const elementsPart =
    elements.trim()
      ? `Additional elements to include in the design: ${elements.trim()}.`
      : '';

  return [
    `Professional tattoo studio concept art, safe for work, non-violent artistic illustration.`,
    refPart,
    `${sujet}, as the central figure.`,
    recipe,
    mood,
    zonePart,
    motPart,
    elementsPart,
    `Highly detailed, fine line work, professional tattoo concept art, sharp clean linework.`,
    TECHNICAL_REQUIREMENTS,
  ].filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────
// Instructions de placement par zone corporelle — étape 2
// ─────────────────────────────────────────────────
const ZONE_PROMPTS = {
  'avant-bras':
    `Body zone: FOREARM. ` +
    `Place the tattoo on the forearm visible in the photo, oriented vertically. ` +
    `The design should run from wrist to elbow, sized to fill the forearm naturally. ` +
    `Wrap the design around the cylindrical shape of the forearm, following its curvature.`,

  'bras-complet':
    `Body zone: FULL ARM SLEEVE. ` +
    `The tattoo covers the entire arm from shoulder to wrist as a full sleeve. ` +
    `Scale the design to span the complete arm length, flowing across the deltoid, bicep, ` +
    `forearm, and down to the wrist, wrapping naturally around the arm's cylindrical shape.`,

  'dos':
    `Body zone: BACK. ` +
    `Place the tattoo large and centered on the back. ` +
    `The design should use the full back canvas, with the spine as the central vertical axis ` +
    `and the composition spreading across both shoulder blades. ` +
    `Large format, bold and imposing, proportional to the back.`,

  'pectoral':
    `Body zone: CHEST / PECTORAL. ` +
    `Place the tattoo on the pectoral area of the chest visible in the photo. ` +
    `Medium format, following the natural curve of the chest muscle. ` +
    `The design should be centered on the pectoral, respecting its rounded shape.`,

  'epaule':
    `Body zone: SHOULDER. ` +
    `Place the tattoo centered on the deltoid shoulder muscle visible in the photo. ` +
    `Compact rounded format, following the curved shape of the shoulder cap. ` +
    `The design wraps slightly around the deltoid, respecting its rounded form.`,

  'cuisse':
    `Body zone: THIGH. ` +
    `Place the tattoo on the outer thigh visible in the photo. ` +
    `Vertical format, running from above the knee up toward the hip. ` +
    `The design follows the cylindrical and muscular shape of the thigh.`,

  'mollet':
    `Body zone: CALF. ` +
    `Place the tattoo centered on the calf muscle visible in the photo. ` +
    `Vertical compact format, sized to fit the calf from ankle to back of knee. ` +
    `Wrap naturally around the rounded calf muscle shape.`,

  'main':
    `Body zone: HAND. ` +
    `Place the tattoo on the back of the hand or fingers visible in the photo. ` +
    `Small compact format, bold and simple shapes, adapted to the limited skin surface. ` +
    `Follow the natural contours of the hand bones and joints.`,
};

// Modèles disponibles pour l'étape 2 (pose sur le corps)
const BODY_MODELS = {
  nano_banana_pro:  { apiModel: 'nano_banana_2', extras: { resolution: '2k' }, label: 'Standard' },
};
const DEFAULT_BODY_MODEL = 'nano_banana_pro';

// ─────────────────────────────────────────────────
// Utilitaires image
// ─────────────────────────────────────────────────

function fileToBase64(filePath) {
  return `data:image/jpeg;base64,${fs.readFileSync(filePath).toString('base64')}`;
}

async function urlToBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Impossible de télécharger l'image : HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

// ─────────────────────────────────────────────────
// Higgsfield via CLI (plus fiable que l'API REST)
// ─────────────────────────────────────────────────

const MODEL_MAP = {
  'image_auto':                 'gpt_image_2',
  'gpt_image_2':                'gpt_image_2',
  'nano_banana_2':              'nano_banana_2',
  'nano_banana_2_skin_enhancer':'nano_banana_2',
  'cinematic_studio_video_3_5': 'seedance_2_0',
};

const HF_API = 'https://fnf.higgsfield.ai';

// Appel REST direct — utilisé quand le CLI ne supporte pas l'option (ex: gpt_image_2 + image)
async function fetchHiggsFieldREST(payload, timeoutMs = 270_000) {
  const apiKey = process.env.HIGGSFIELD_API_KEY || '';
  const body   = { ...payload };

  // Soumettre le job
  const submitRes = await fetch(`${HF_API}/agents/jobs`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const submitted = await submitRes.json();
  console.log('REST submit:', JSON.stringify(submitted).slice(0, 300));
  if (!submitRes.ok || !submitted.id) throw new Error('REST submit failed: ' + JSON.stringify(submitted).slice(0, 200));

  const jobId    = submitted.id;
  const deadline = Date.now() + timeoutMs;

  // Poll jusqu'au résultat
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const pollRes  = await fetch(`${HF_API}/agents/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const job = await pollRes.json();
    console.log('REST poll:', job.status, job.result_url || '');
    if (job.status === 'completed' && job.result_url) return { imageUrl: job.result_url, jobId };
    if (job.status === 'failed') throw new Error('Job failed: ' + JSON.stringify(job).slice(0, 200));
  }
  throw new Error('Timeout waiting for REST job');
}

async function fetchHiggsfield(payload, nsfwMsg, timeoutMs = 270_000) {
  const model  = MODEL_MAP[payload.model] || payload.model || 'nano_banana_2';
  const prompt = payload.prompt || '';
  const tmpFiles = [];

  // gpt_image_2 avec images → REST direct (le CLI ne supporte pas --image pour ce modèle)
  if (model === 'gpt_image_2' && Array.isArray(payload.images) && payload.images.length > 0) {
    return fetchHiggsFieldREST({ model, prompt, images: payload.images, resolution: payload.resolution || '2k' }, timeoutMs);
  }

  try {
    const args = ['generate', 'create', model, '--prompt', prompt, '--wait'];

    if (Array.isArray(payload.images)) {
      for (const b64 of payload.images) {
        const data = b64.replace(/^data:image\/\w+;base64,/, '');
        const tmp  = path.join(os.tmpdir(), `hf-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
        fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
        tmpFiles.push(tmp);
        args.push('--image', tmp);
      }
    }

    if (payload.resolution) args.push('--resolution', payload.resolution);

    const imageUrl = await runCLI(args, timeoutMs);
    return { imageUrl, jobId: null };

  } finally {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}

function runCLI(args, timeoutMs, retry = true) {
  return new Promise((resolve, reject) => {
    // Appel direct au binaire hf (bypass du wrapper Node qui re-spawn sans nos env vars)
    const binName   = process.platform === 'win32' ? 'hf.exe' : 'hf';
    const vendorBin = path.join(__dirname, 'node_modules', '@higgsfield', 'cli', 'vendor', binName);
    const bin       = fs.existsSync(vendorBin) ? vendorBin : binName;

    // Passe le token en variable d'environnement au CLI
    const env = {
      ...process.env,
      HIGGSFIELD_API_KEY:       process.env.HIGGSFIELD_API_KEY || '',
      HIGGSFIELD_REFRESH_TOKEN: process.env.HIGGSFIELD_REFRESH_TOKEN || '',
      HOME: os.homedir(),
    };

    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env }, async (err, stdout, stderr) => {
      // Log complet pour diagnostic
      if (stdout) console.log('CLI stdout:', stdout.slice(0, 500));
      if (stderr) console.log('CLI stderr:', stderr.slice(0, 500));
      if (err)    console.log('CLI err.message:', err.message?.slice(0, 300));

      if (err) {
        const detail = (stderr || err.message || '').slice(0, 500);
        console.error('❌ CLI failed. Full detail:', detail);
        return reject(new Error('Generation failed: ' + detail));
      }
      const url = stdout.trim().split('\n').map(l => {
        const m = l.match(/https?:\/\/\S+/);
        return m ? m[0] : null;
      }).filter(Boolean).pop();
      if (!url) {
        console.error('❌ No URL in CLI output:', stdout.slice(0, 300));
        return reject(new Error('Generation failed. Please try again.'));
      }
      resolve(url);
    });
  });
}

function refreshHiggsfieldToken() {
  return new Promise((resolve, reject) => {
    const credFile = path.join(os.homedir(), '.config', 'higgsfield', 'credentials.json');
    let creds;
    try { creds = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch { return reject(new Error('Cannot read credentials file')); }
    if (!creds.refresh_token) return reject(new Error('No refresh token available'));

    const https = require('https');
    const body  = JSON.stringify({ refresh_token: creds.refresh_token });
    const opts  = {
      hostname: 'api.higgsfield.ai',
      path:     '/auth/refresh',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.access_token) {
            creds.access_token = j.access_token;
            if (j.refresh_token) creds.refresh_token = j.refresh_token;
            fs.writeFileSync(credFile, JSON.stringify(creds));
            console.log('✓ Higgsfield token refreshed');
            resolve();
          } else {
            reject(new Error('Refresh response: ' + data.slice(0, 100)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Retourne un message d'erreur safe pour le client (jamais de détails techniques)
function clientError(err) {
  return err.message || 'Generation failed. Please try again in a moment.';
}

// ─────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use(cors());

// ── Download proxy (cross-origin image download) ──
app.get('/download', async (req, res) => {
  const { url, filename = 'ink-studio.jpg' } = req.query;
  if (!url || !url.startsWith('https://')) return res.status(400).send('Invalid URL');
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send('Failed to fetch image');
    const buffer = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (e) {
    console.error('❌ /download :', e.message);
    res.status(500).send('Download error');
  }
});

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ─────────────────────────────────────────────────
// POST /generate — ÉTAPE 1 : génération du design
// Body  : sujet, style, ambiance, mot, elements, zone
// File  : inspiration (optionnel)
// Retour: { imageUrl, jobId, prompt, zone }
// ─────────────────────────────────────────────────
app.post('/generate', upload.single('inspiration'), async (req, res) => {
  const sujet      = (req.body.sujet    || req.body.description || '').trim();
  const style      = (req.body.style    || 'concept').trim();
  const ambiance   = (req.body.ambiance || 'epique').trim();
  const mot        = (req.body.mot      || '').trim();
  const elements   = (req.body.elements || '').trim();
  const zone       = (req.body.zone     || '').trim();
  const freePrompt = req.body.freePrompt === '1';
  const inspFile   = req.file || null;

  if (!sujet) {
    if (inspFile && fs.existsSync(inspFile.path)) fs.unlinkSync(inspFile.path);
    return res.status(400).json({ error: 'Le sujet est vide.' });
  }

  // Free prompt: use the user's text directly, just add technical requirements
  const prompt = freePrompt
    ? `${sujet}. ${TECHNICAL_REQUIREMENTS}`
    : buildPrompt({ sujet, style, ambiance, mot, elements, zone, withReference: !!inspFile });
  let   inspPath   = null;

  try {
    console.log('\n🎨 Nouvelle génération');
    console.log('   Sujet   :', sujet);
    console.log('   Style   :', style, '/ Ambiance :', ambiance);
    console.log('   Ref     :', inspFile ? 'oui' : 'non');

    let payload;

    if (inspFile) {
      inspPath = inspFile.path + '.jpg';
      fs.renameSync(inspFile.path, inspPath);
      payload = {
        model:      'gpt_image_2',
        prompt,
        images:     [fileToBase64(inspPath)],
        resolution: '2k',
      };
    } else {
      payload = {
        model:  'gpt_image_2',
        prompt,
      };
    }

    const { imageUrl, jobId } = await fetchHiggsfield(payload,
      'La génération a été bloquée par le filtre du modèle.\n' +
      'Essaie de reformuler ta description — évite les termes d\'armes, de violence ou de symboles religieux forts.'
    );

    res.json({ imageUrl, jobId, prompt, zone });

  } catch (err) {
    console.error('❌ /generate :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (inspPath && fs.existsSync(inspPath)) fs.unlinkSync(inspPath);
  }
});

// ─────────────────────────────────────────────────
// POST /generate-on-body — ÉTAPE 2 : pose sur le corps
// Body  : designUrl (URL de l'image générée), zone, model (opt.)
// File  : photo
// Retour: { imageUrl, jobId, model }
// ─────────────────────────────────────────────────
app.post('/generate-on-body', upload.single('photo'), async (req, res) => {
  // designUrl = URL de l'image du design (retournée par /generate)
  const designUrl = (req.body.designUrl || '').trim();
  const zone      = (req.body.zone      || '').trim();
  const modelKey  = BODY_MODELS[req.body.model] ? req.body.model : DEFAULT_BODY_MODEL;

  if (!req.file)    return res.status(400).json({ error: 'Aucune photo reçue.' });
  if (!designUrl)   return res.status(400).json({ error: 'URL du design manquante. Génère d\'abord un design à l\'étape 1.' });
  if (!ZONE_PROMPTS[zone]) return res.status(400).json({ error: 'Zone corporelle invalide.' });

  const photoPath = req.file.path + '.jpg';
  fs.renameSync(req.file.path, photoPath);

  try {
    console.log('\n📸 Rendu sur le corps — étape 2');
    console.log('   Zone   :', zone);
    console.log('   Modèle :', modelKey);

    const prompt =
      `Two images are provided: image 1 is a body photo, image 2 is a tattoo design on white background. ` +
      `Apply the tattoo design from image 2 onto the skin in image 1. ` +
      `${ZONE_PROMPTS[zone]} ` +
      `CRITICAL: preserve the EXACT same framing, crop, zoom level, angle, perspective, and composition as image 1 — do NOT zoom in, do NOT reframe, do NOT change the camera distance. ` +
      `The output image must have the identical framing as the input photo. ` +
      `The tattoo ink must follow the skin's natural texture, lighting, highlights and shadows from the photo. ` +
      `Photorealistic tattoo result, looks like a real tattoo on real skin, professional tattoo artist quality. ` +
      `Keep every detail of the background, clothing, and surroundings completely unchanged.`;

    // Conversion des deux images en base64 en parallèle
    const [photoB64, designB64] = await Promise.all([
      Promise.resolve(fileToBase64(photoPath)),
      urlToBase64(designUrl),
    ]);

    const { apiModel, extras } = BODY_MODELS[modelKey];
    const payload = {
      model:  apiModel,
      prompt,
      images: [photoB64, designB64],
      ...extras,
    };

    const { imageUrl, jobId } = await fetchHiggsfield(payload,
      'La photo a été bloquée par le filtre de contenu du modèle.\n' +
      'Essaie avec une photo où le bras ou la zone est bien visible sur un fond neutre, sans excès de peau exposée.'
    );

    res.json({ imageUrl, jobId, model: modelKey });

  } catch (err) {
    console.error('❌ /generate-on-body :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
});

// ─────────────────────────────────────────────────
// POST /place-uploaded-design — PARCOURS 2
// Files : design (image uploadée) + photo
// Body  : zone
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/place-uploaded-design', upload.fields([
  { name: 'design', maxCount: 1 },
  { name: 'photo',  maxCount: 1 },
]), async (req, res) => {
  const zone = (req.body.zone || '').trim();

  if (!req.files?.design?.[0]) return res.status(400).json({ error: 'Aucun design reçu.' });
  if (!req.files?.photo?.[0])  return res.status(400).json({ error: 'Aucune photo reçue.' });
  if (!ZONE_PROMPTS[zone])     return res.status(400).json({ error: 'Zone corporelle invalide.' });

  const designPath = req.files.design[0].path + '.jpg';
  const photoPath  = req.files.photo[0].path  + '.jpg';
  fs.renameSync(req.files.design[0].path, designPath);
  fs.renameSync(req.files.photo[0].path,  photoPath);

  try {
    console.log('\n🎨 Design uploadé — parcours 2');
    console.log('   Zone :', zone);

    const prompt =
      `Two images are provided: image 1 is a body photo, image 2 is a tattoo design on white background. ` +
      `Apply the tattoo design from image 2 onto the skin in image 1. ` +
      `${ZONE_PROMPTS[zone]} ` +
      `CRITICAL: preserve the EXACT same framing, crop, zoom level, angle, perspective, and composition as image 1 — do NOT zoom in, do NOT reframe, do NOT change the camera distance. ` +
      `The output image must have the identical framing as the input photo. ` +
      `The tattoo ink must follow the skin's natural texture, lighting, highlights and shadows from the photo. ` +
      `Photorealistic tattoo result, looks like a real tattoo on real skin, professional tattoo artist quality. ` +
      `Keep every detail of the background, clothing, and surroundings completely unchanged.`;

    const payload = {
      model:      'nano_banana_2',
      prompt,
      images:     [fileToBase64(photoPath), fileToBase64(designPath)],
      resolution: '2k',
    };

    const { imageUrl } = await fetchHiggsfield(payload,
      'La photo a été bloquée par le filtre de contenu du modèle.\n' +
      'Essaie avec une photo où la zone est bien visible sur un fond neutre.'
    );

    res.json({ imageUrl });

  } catch (err) {
    console.error('❌ /place-uploaded-design :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(designPath)) fs.unlinkSync(designPath);
    if (fs.existsSync(photoPath))  fs.unlinkSync(photoPath);
  }
});

// ─────────────────────────────────────────────────
// POST /generate-pet-tattoo — Mode animal
// File  : photo (photo de l'animal)
// Body  : style, details (texte libre), zone (optionnel)
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/generate-pet-tattoo', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo received.' });

  const style   = (req.body.style   || 'realism').trim();
  const details = (req.body.details || '').trim();
  const zone    = (req.body.zone    || '').trim();

  const photoPath = req.file.path + '.jpg';
  fs.renameSync(req.file.path, photoPath);

  const stylePrompts = {
    realism:    'photorealistic black and grey realism tattoo, ultra-detailed fur and eyes, deep contrast, fine lines',
    fineline:   'fine line tattoo, delicate single-needle style, minimal shading, elegant linework',
    geometric:  'geometric tattoo design, dotwork and sacred geometry patterns integrated with the animal portrait',
    watercolor: 'watercolor tattoo style, soft ink washes, painterly strokes, vibrant but controlled color bleeding',
    traditional:'bold traditional tattoo style, thick black outlines, solid fills, classic flash art aesthetic',
  };
  const styleDesc = stylePrompts[style] || stylePrompts.realism;

  const prompt =
    `Create a professional tattoo design inspired by the subject in the photo. ` +
    `Style: ${styleDesc}. ` +
    `Capture the most distinctive and recognizable features of the subject — whether it's an animal, person, landscape, or object. ` +
    (details ? `Additional details to include: ${details}. ` : '') +
    `White background, tattoo flash art composition, ready to tattoo. ` +
    `High resolution, professional tattoo artist quality.`;

  try {
    console.log('\n🐾 Pet tattoo generation');
    console.log('   Style   :', style);
    console.log('   Details :', details || 'none');

    const payload = {
      model:      'nano_banana_2',
      prompt,
      images:     [fileToBase64(photoPath)],
      resolution: '2k',
    };

    const { imageUrl } = await fetchHiggsfield(payload,
      'The photo was blocked by the content filter. Try a clearer, well-lit photo of the animal.'
    );

    res.json({ imageUrl, zone });

  } catch (err) {
    console.error('❌ /generate-pet-tattoo :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
});

// ─────────────────────────────────────────────────
// POST /merge-tattoos — Mode 4 : fusionner plusieurs designs
// Files : design0, design1, design2, design3 (2–4 images)
// Body  : style, details, count
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/merge-tattoos', upload.fields([
  { name: 'design0', maxCount: 1 },
  { name: 'design1', maxCount: 1 },
  { name: 'design2', maxCount: 1 },
  { name: 'design3', maxCount: 1 },
]), async (req, res) => {
  const count  = parseInt(req.body.count || '2');
  const style  = (req.body.style   || 'seamless').trim();
  const details= (req.body.details || '').trim();

  const tmpFiles = [];
  const base64Images = [];

  for (let i = 0; i < count; i++) {
    const key = `design${i}`;
    if (!req.files[key] || !req.files[key][0]) continue;
    const f = req.files[key][0];
    const p = f.path + '.jpg';
    fs.renameSync(f.path, p);
    tmpFiles.push(p);
    base64Images.push(fileToBase64(p));
  }

  if (base64Images.length < 2) {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    return res.status(400).json({ error: 'Please upload at least 2 designs.' });
  }

  const stylePrompts = {
    seamless:    'seamlessly blended into one cohesive tattoo composition, unified style and flow, harmonious design',
    collage:     'artistic collage tattoo, each element distinct but visually connected through shared space and linework',
    blackgrey:   'unified black and grey tattoo, smooth gradients, fine shading, all elements merged in monochromatic style',
    fineline:    'fine line tattoo fusion, delicate single-needle linework connecting all elements into one elegant composition',
    traditional: 'bold traditional tattoo style, thick outlines, all designs merged with classic flash art aesthetic',
  };
  const styleDesc = stylePrompts[style] || stylePrompts.seamless;

  const prompt =
    `You are a master tattoo artist. Fuse the ${base64Images.length} tattoo designs provided into a single unique tattoo masterpiece. ` +
    `The result must be ${styleDesc}. ` +
    `Incorporate the key visual elements from every design into one cohesive artwork. ` +
    (details ? `Creative direction: ${details}. ` : '') +
    `White background, professional tattoo flash art composition, high resolution, ready to tattoo.`;

  try {
    console.log(`\n⚡ Merge tattoos — ${base64Images.length} designs, style: ${style}`);

    const { imageUrl } = await fetchHiggsfield({
      model:      'nano_banana_2',
      prompt,
      images:     base64Images,
      resolution: '2k',
    }, 'One of the designs was blocked by the content filter. Try with different images.');

    res.json({ imageUrl });
  } catch (err) {
    console.error('❌ /merge-tattoos :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ─────────────────────────────────────────────────
// POST /generate-video — ÉTAPE 3 (masquée dans l'UI)
// Body  : sourceUrl (URL de l'image de prévisualisation corps)
// Retour: { videoUrl }
// ─────────────────────────────────────────────────
app.post('/generate-video', upload.none(), async (req, res) => {
  const sourceUrl = (req.body.sourceUrl || '').trim();

  if (!sourceUrl) {
    return res.status(400).json({ error: 'URL source manquante. Génère d\'abord un design à l\'étape 1.' });
  }

  const prompt =
    `Slow cinematic 360 degree camera orbit around the tattooed arm and body. ` +
    `The camera glides in a smooth, continuous circle around the subject, ` +
    `revealing the tattoo design from every angle with a graceful, fluid arc. ` +
    `Dramatic directional studio spotlight illuminates every detail of the ink. ` +
    `Deep pure black background. Perfectly steady orbital camera movement, no shake. ` +
    `Elegant premium luxury tattoo studio reveal. ` +
    `Silver and black ink reflections catching the light as the camera rotates.`;

  try {
    console.log('\n🎬 Génération vidéo — étape 3');

    const imageB64 = await urlToBase64(sourceUrl);

    const payload = {
      model:  'cinematic_studio_video_3_5',
      prompt,
      images: [imageB64],
    };

    const { imageUrl: videoUrl } = await fetchHiggsfield(
      payload,
      'La génération vidéo a été bloquée par le filtre du modèle.',
      600_000,
      'generation/video'
    );

    res.json({ videoUrl });

  } catch (err) {
    console.error('❌ /generate-video :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Serveur démarré sur http://localhost:${PORT}`);
  console.log('   Ouvre index.html dans ton navigateur pour utiliser l\'app.');
  console.log('   Laisse ce terminal ouvert pendant que tu travailles.\n');
});
