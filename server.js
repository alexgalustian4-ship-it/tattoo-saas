'use strict';

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const HF_BASE = 'https://api.higgsfield.ai/v1';

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
  gpt_image_2:      { apiModel: 'gpt_image_2',                  extras: { quality: 'high' },    label: 'GPT Image 2' },
  nano_banana_pro:  { apiModel: 'nano_banana_2',                 extras: { resolution: '2k' },   label: 'Nano Banana Pro' },
  nano_banana_skin: { apiModel: 'nano_banana_2_skin_enhancer',   extras: { resolution: '2k' },   label: 'Nano Banana Skin' },
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

function getApiKey() {
  const key = process.env.HIGGSFIELD_API_KEY;
  if (!key) throw new Error('Variable d\'environnement HIGGSFIELD_API_KEY non définie.');
  return key;
}

// ─────────────────────────────────────────────────
// Appel REST Higgsfield + polling jusqu'au résultat
// payload  — body JSON envoyé à l'API
// nsfwMsg  — message d'erreur si le filtre bloque
// timeoutMs — délai max en millisecondes (défaut 5 min)
// endpoint — "generation/image" ou "generation/video"
// ─────────────────────────────────────────────────
async function fetchHiggsfield(payload, nsfwMsg, timeoutMs = 300_000, endpoint = 'generation/image') {
  const apiKey   = getApiKey();
  const deadline = Date.now() + timeoutMs;

  // Lancement du job
  const createResp = await fetch(`${HF_BASE}/${endpoint}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!createResp.ok) {
    const err = await createResp.json().catch(() => ({}));
    throw new Error(err.message || err.error || `API Higgsfield : HTTP ${createResp.status}`);
  }

  const created = await createResp.json();

  // Résultat immédiat (mode synchrone)
  if (created.status === 'completed') {
    return extractResult(created, nsfwMsg);
  }
  if (created.status === 'nsfw') {
    throw new Error(nsfwMsg);
  }

  // Job asynchrone : on poll jusqu'à ce qu'il soit terminé
  const jobId = created.id;
  if (!jobId) throw new Error(`Réponse inattendue de l'API Higgsfield : ${JSON.stringify(created).slice(0, 200)}`);

  while (Date.now() < deadline) {
    await sleep(4_000);

    const pollResp = await fetch(`${HF_BASE}/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue; // erreur réseau transitoire — on réessaie

    const job = await pollResp.json();

    if (job.status === 'nsfw')      throw new Error(nsfwMsg);
    if (job.status === 'failed')    throw new Error('La génération a échoué côté Higgsfield.');
    if (job.status === 'completed') return extractResult(job, nsfwMsg, jobId);
  }

  throw new Error('Timeout : la génération a pris trop de temps (> ' + Math.round(timeoutMs / 60000) + ' min).');
}

function extractResult(data, nsfwMsg, fallbackJobId = null) {
  if (data.status === 'nsfw') throw new Error(nsfwMsg);
  const imageUrl = data.result_url || data.url;
  if (!imageUrl) throw new Error('URL manquante dans la réponse Higgsfield.');
  return { imageUrl, jobId: data.id || fallbackJobId };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use(cors());

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ─────────────────────────────────────────────────
// POST /generate — ÉTAPE 1 : génération du design
// Body  : sujet, style, ambiance, mot, elements, zone
// File  : inspiration (optionnel)
// Retour: { imageUrl, jobId, prompt, zone }
// ─────────────────────────────────────────────────
app.post('/generate', upload.single('inspiration'), async (req, res) => {
  const sujet    = (req.body.sujet    || req.body.description || '').trim();
  const style    = (req.body.style    || 'concept').trim();
  const ambiance = (req.body.ambiance || 'epique').trim();
  const mot      = (req.body.mot      || '').trim();
  const elements = (req.body.elements || '').trim();
  const zone     = (req.body.zone     || '').trim();
  const inspFile = req.file || null;

  if (!sujet) {
    if (inspFile && fs.existsSync(inspFile.path)) fs.unlinkSync(inspFile.path);
    return res.status(400).json({ error: 'Le sujet est vide.' });
  }

  const prompt     = buildPrompt({ sujet, style, ambiance, mot, elements, zone, withReference: !!inspFile });
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
        model:      'nano_banana_2',
        prompt,
        images:     [fileToBase64(inspPath)],
        resolution: '2k',
      };
    } else {
      payload = {
        model:  'image_auto',
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
    res.status(500).json({ error: err.message });
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
      `The tattoo ink must follow the skin's natural texture, lighting, highlights and shadows from the photo. ` +
      `Black and grey realism, photorealistic result, professional tattoo artist quality. ` +
      `Keep everything else in the photo completely unchanged.`;

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
    res.status(500).json({ error: err.message });
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
      `The tattoo ink must follow the skin's natural texture, lighting, highlights and shadows from the photo. ` +
      `Black and grey realism, photorealistic result, professional tattoo artist quality. ` +
      `Keep everything else in the photo completely unchanged.`;

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
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(designPath)) fs.unlinkSync(designPath);
    if (fs.existsSync(photoPath))  fs.unlinkSync(photoPath);
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
