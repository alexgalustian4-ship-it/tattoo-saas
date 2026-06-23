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

// ═══════════════════════════════════════════════════
// BASE DE DONNÉES (Postgres) — inerte si DATABASE_URL absent
// ═══════════════════════════════════════════════════
// Crédits par plan (1 génération = 10 crédits → gros chiffres, même rentabilité)
const PLAN_CREDITS = { free: 30, pro: 400, studio: 1500 };
// Coût en crédits par action
const CREDIT_COST = { design: 10, body: 15, stencil: 10, merge: 15, pet: 10 };
let db = null;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    db.on('error', e => console.warn('⚠ DB pool error:', e.message));
  }
} catch (e) { console.warn('⚠ pg init failed:', e.message); }

async function initDb() {
  if (!db) { console.warn('⚠ DATABASE_URL non défini — base de données désactivée'); return; }
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               BIGSERIAL PRIMARY KEY,
        email            TEXT UNIQUE NOT NULL,
        google_id        TEXT UNIQUE,
        name             TEXT,
        avatar_url       TEXT,
        plan             TEXT NOT NULL DEFAULT 'free',
        credits_remaining INTEGER NOT NULL DEFAULT 5,
        credits_reset_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
        stripe_customer_id TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS generations (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL DEFAULT 'design',
        image_url   TEXT NOT NULL,
        params      JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id, created_at DESC);`);
    console.log('✓ Base de données prête (tables users, generations)');
  } catch (e) {
    console.error('❌ initDb failed:', e.message);
  }
}
initDb();

// ── Higgsfield token refresh state ──
let _refreshInProgress = null;

// ── Stockage persistant des credentials ──
// Sur Railway, RAILWAY_VOLUME_MOUNT_PATH pointe vers un volume qui survit aux
// redémarrages. Sinon on retombe sur le HOME (ex: en local). On force HOME vers
// ce répertoire pour que le binaire CLI lise/écrive le MÊME fichier que nous.
const PERSIST_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.homedir();
process.env.HOME = PERSIST_DIR; // le CLI utilise ~/.config/higgsfield/credentials.json

function credFilePath() {
  return path.join(PERSIST_DIR, '.config', 'higgsfield', 'credentials.json');
}

function writeCredentials(access, refresh) {
  const credFile = credFilePath();
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ access_token: access, refresh_token: refresh || '' }));
  return credFile;
}

function readPersistedCredentials() {
  try {
    const creds = JSON.parse(fs.readFileSync(credFilePath(), 'utf8'));
    if (creds.access_token) return creds;
  } catch {}
  return null;
}

async function bootstrapHiggsfieldAuth() {
  // 1) Priorité au fichier persistant (token déjà rafraîchi lors d'un run précédent)
  const persisted = readPersistedCredentials();
  if (persisted) {
    process.env.HIGGSFIELD_API_KEY = persisted.access_token;
    if (persisted.refresh_token) process.env.HIGGSFIELD_REFRESH_TOKEN = persisted.refresh_token;
    console.log('✓ Credentials chargés depuis le volume persistant, prefix =', persisted.access_token.slice(0, 8));
  } else {
    // 2) Premier démarrage : on seed depuis les variables d'env
    const access  = process.env.HIGGSFIELD_API_KEY;
    const refresh = process.env.HIGGSFIELD_REFRESH_TOKEN || '';
    if (!access) { console.warn('⚠ HIGGSFIELD_API_KEY not set — generation will fail'); return; }
    writeCredentials(access, refresh);
    console.log('✓ Credentials seedés depuis les variables d\'env. PERSIST_DIR =', PERSIST_DIR, '| prefix =', access.slice(0, 8));
  }

  // 3) Rafraîchit immédiatement au démarrage via le CLI binaire
  try {
    await refreshHiggsfieldToken();
  } catch (e) {
    console.warn('⚠ Startup token refresh failed:', e.message);
  }
}

bootstrapHiggsfieldAuth();

// Refresh proactif toutes les 45 min pour ne jamais expirer
setInterval(() => {
  refreshHiggsfieldToken().catch(e => console.warn('⚠ Periodic token refresh failed:', e.message));
}, 45 * 60 * 1000);

// ─────────────────────────────────────────────────
// Prompt système designer — base de toute génération de design
// ─────────────────────────────────────────────────
const DESIGN_SYSTEM_PROMPT =
  `You are an expert tattoo designer specialized in creating original, high-quality tattoo concepts. ` +
  `Transform the idea into a visually balanced tattoo composition, not a random illustration. ` +
  `Always prioritize composition, readability, body flow, and long-term tattoo quality. ` +
  `Create a unique composition with one dominant focal point. Avoid clutter, duplicated objects, repetitive patterns and random decorative elements. ` +
  `Every element must have a purpose. Balance negative space and detailed areas. Keep proportions realistic and the design tattooable by a professional artist. ` +
  `Build with a main subject, supporting elements, background only when it improves the composition, depth through layering, natural visual flow, balanced spacing, strong silhouette. ` +
  `The design must remain readable from a distance, have clean shapes, logical lighting, preserve important details and avoid muddy areas. ` +
  `Only use the explicitly requested style. Never create generic AI-looking artwork — every composition must feel intentional, premium and unique.`;

// ─────────────────────────────────────────────────
// Prompt Stencil (photo → stencil pro Spirit) pour gpt-image-1
// ─────────────────────────────────────────────────
const STENCIL_PROMPT =
  `Convert this photograph into a maximum fidelity technical tattoo tracing. I want an exact linear outline, with the figure perfectly adapted to the original reference, respecting the scale, tilt, perspective, and placement of every element. ` +
  `Result style: fine, uniform red line; clean white background; no shading; no solid black masses; no halftones; no grays; no skin texture or photographic texture; no artistic reinterpretation. ` +
  `Must include: overall contour of the silhouette; exact facial features and expression; important wrinkles and folds of the face and neck; ears, earrings, accessories; hands with clear anatomical structure; clothing with essential folds; main objects complete and clearly defined; useful internal details for tattooing, simplified only if they create visual noise. ` +
  `Must exclude or minimize: full background; blur; atmosphere; stains; noise; microtextures; excessive irrelevant detail. ` +
  `Shadow elements: work on the shadows in the face. Mark four shadow values — areas of solid black, dark tones, light tones, and highlight zones — all using the same red line but with a dashed line. Do not add any labels or indication of which shadow value is which; only outline the area that belongs to each shadow zone. ` +
  `The final image should look like a clean, precise, readable stencil/tracing, ready to use as a tattoo base.`;

// ─────────────────────────────────────────────────
// Recettes de style — prompts officiels (gpt-image-1)
// ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════
// STYLE ENGINE — source unique de vérité par style
// recipe = description complète · keyMarkers = ancrage visuel (placé EN PREMIER)
// defaultFormat = format si pas de zone · colorByDefault = couleur par défaut
// ═══════════════════════════════════════════════════
const STYLES = {
  concept: {
    label: 'Concept',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'symbolic black & grey concept composition, one strong central subject, fine drafting lines, sacred-geometry construction, generous negative space, premium editorial layout',
    recipe:
      `Create the tattoo in a Concept style, built around visual storytelling rather than simple illustration — every element contributes to a larger symbolic narrative, like an artistic concept piece by a high-end tattoo designer. ` +
      `Strong central subject, supporting elements connected through symbolism, intelligent composition rather than decoration, minimal but meaningful background, clean hierarchy, large areas of breathing space. ` +
      `Build with multiple layers: primary subject, secondary symbolic elements, architectural or environmental details when relevant, geometric construction only if it strengthens the composition, atmospheric depth. Every object interacts with the others; avoid isolated floating elements. ` +
      `The tattoo must communicate an idea, emotion or philosophy; every symbol has a purpose; avoid generic symbolism or random combinations. ` +
      `Mix realism with conceptual composition, allow natural overlap, create tension between positive and negative space, use scale creatively. Keep the focal point highly detailed while secondary elements become progressively lighter. ` +
      `Look like a luxury custom tattoo concept by an elite artist — unique, intelligent, emotionally powerful, premium, never generic AI-generated.`,
  },

  baroque: {
    label: 'Baroque',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'dramatic black & grey baroque composition, marble sculpture realism, ornate scrollwork and Corinthian columns, cathedral architecture, deep chiaroscuro, regal and luxurious',
    recipe:
      `Create the tattoo in a Baroque style inspired by the grandeur of Baroque and Renaissance art, combining dramatic realism, ornate architecture and rich decorative details; luxurious, timeless and sculptural. ` +
      `Central focal subject, ornate architectural structures, decorative Baroque frames and flourishes, sculptures/statues/classical figures when relevant, columns, arches, domes or cathedral details, elegant symmetry or controlled asymmetry, soft atmospheric depth. ` +
      `Incorporate authentic Baroque/Renaissance influences when appropriate: ornamental scrollwork, Corinthian columns, cathedral windows, domes, marble sculptures, decorative moldings, royal emblems, arches, classical reliefs, stone textures — architecture frames the artwork naturally. ` +
      `Any human or angelic figures are fully clothed in flowing robes and drapery — no nudity, no bare skin, modest and reverent. ` +
      `Dramatic lighting inspired by classical paintings: strong highlights, deep shadows, powerful contrast emphasizing volume and architectural depth. Intricate detail in carvings, marble, drapery and flourishes, fading toward the edges for readability. ` +
      `Look like a masterpiece carved from marble surrounded by magnificent Baroque architecture — regal, timeless, sophisticated, worthy of a luxury custom tattoo, never a generic AI illustration.`,
  },

  japonais: {
    label: 'Japanese',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'Japanese irezumi composition, bold confident outlines, flowing waves/clouds/wind, dynamic movement, traditional symbolism, balanced negative space',
    recipe:
      `Create the tattoo in a Japanese (Irezumi) style inspired by traditional Japanese tattooing with modern interpretation — harmonious, powerful, symbolic and fluid, following the body's anatomy. ` +
      `One dominant central subject, supporting symbolic elements, natural environmental elements, flowing background textures, continuous movement throughout. Every element connects naturally; avoid isolated or randomly placed objects. ` +
      `When relevant incorporate authentic Japanese symbolism (dragons, koi, tigers, phoenix, samurai, oni/hannya masks, snakes, cranes, cherry blossoms, peonies, maple leaves, waves, wind bars, clouds, smoke, moon, sun) — only elements that strengthen the concept. ` +
      `Subjects emerge from waves, clouds, wind or smoke rather than floating; strong energy and direction. Intricate detail in scales, fur, feathers, armor, fabric folds, flowers, waves and clouds; focal point detailed while secondary elements breathe. ` +
      `If color is requested use a traditional Japanese palette (deep black, crimson, vermilion, indigo, emerald, muted gold, ivory); otherwise powerful black and grey. ` +
      `Look like an authentic high-end Irezumi masterpiece — dynamic, symbolic, timeless, balanced and visually powerful.`,
  },

  geometrique: {
    label: 'Geometric',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'precise black & grey geometric design, sacred geometry, fine dotwork, perfectly clean straight lines and circles, mathematical symmetry, blueprint construction lines',
    recipe:
      `Create the tattoo in a Geometric style based on precision, balance, symmetry and mathematical harmony — every line, shape and proportion intentional and perfectly constructed; geometry enhances the subject, never overpowers it. ` +
      `One dominant central subject, geometric structures supporting the composition, balanced spacing, controlled repetition, layered geometric depth, clear focal point; avoid random decorative geometry. ` +
      `When appropriate incorporate sacred geometry, Metatron's Cube, Flower of Life, golden ratio, Fibonacci spiral, platonic solids, hexagons, triangles, circles, mandalas, polygonal structures, radial patterns, blueprint construction lines, fine dotwork — only elements that support the concept. ` +
      `Perfectly straight lines, smooth curves, consistent line weight, crisp intersections, clean circles, accurate angles; no shaky or unnecessary lines. Detail through dotwork, repeating patterns, geometric textures and subtle construction lines. ` +
      `Look like a premium geometric tattoo designed with architectural precision — balanced, intelligent, elegant, timeless, visually striking and technically tattooable.`,
  },

  realisme: {
    label: 'Realism',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'hyper-realistic black & grey realism, smooth photoreal shading, deep contrast, ultra-fine detail, lifelike textures, dramatic lighting',
    recipe:
      `Create the tattoo in a Realism style — lifelike imagery with exceptional accuracy, natural proportions and realistic depth; authentic, dimensional, emotionally expressive, fully tattooable. Premium black & grey realism unless color is explicitly requested. ` +
      `One dominant realistic subject, supporting elements only when they strengthen the story, natural layering, balanced negative space, smooth visual flow, strong depth and perspective; avoid unnecessary decorative elements. ` +
      `Preserve realistic anatomy, authentic proportions, natural perspective, facial accuracy, believable expressions, realistic textures, correct lighting and physical depth; never stylized or cartoon-like. ` +
      `Realistic directional lighting, smooth value transitions, deep shadows, bright highlights, natural contrast defining volume. Authentic textures (skin, marble, stone, metal, fabric, feathers, fur, hair, leather, smoke, water) that never become noisy. ` +
      `Exceptional detail in eyes, facial features, hands, muscles, hair, clothing folds and key objects, reducing detail away from the focal point. Depth via foreground/midground/background and atmospheric perspective. Prioritize tattoo longevity over photographic perfection. ` +
      `Look like a world-class black and grey realism tattoo by an elite artist — authentic, emotionally powerful, technically flawless, timeless, never AI-generated or a manipulated photograph.`,
  },
};

function getStyle(key) { return STYLES[key] || STYLES.concept; }

// Compat : certains endroits lisent encore une recette par clé
const STYLE_RECIPES = Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.recipe]));

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
    DESIGN_SYSTEM_PROMPT,
    `Strictly safe for work, fully clothed figures only, no nudity, no bare skin, non-violent.`,
    refPart,
    `Subject (the central focal point of the tattoo): ${sujet}.`,
    recipe,
    mood,
    zonePart,
    motPart,
    elementsPart,
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
    `Body zone: UPPER BACK. ` +
    `Place the tattoo centered on the upper and middle back, with the spine as the central vertical axis ` +
    `and the composition spread across both shoulder blades. ` +
    `Keep a clear margin of bare skin on all sides: the design must stop well ABOVE the waistband and shorts, ` +
    `never reaching the lower back or hips. Do not fill the entire back edge to edge. ` +
    `Proportional, bold, but contained within the bare skin of the upper back only.`,

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
  nano_banana_pro:  { apiModel: 'gpt_image_2', extras: { resolution: '2k' }, label: 'Standard' },
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

// Upload an image buffer to Higgsfield media — returns {id, url}
async function uploadImageToHiggsfield(buffer, mimeType = 'image/jpeg', retry = true) {
  const apiKey = process.env.HIGGSFIELD_API_KEY || '';

  // Build multipart body manually for maximum compatibility
  const boundary = '----HFBoundary' + Date.now().toString(16);
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body   = Buffer.concat([header, buffer, footer]);

  // Step 1: get presigned S3 URL
  const initRes = await fetch(`${HF_API}/agents/uploads?type=image`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (initRes.status === 401 && retry) {
    console.log('🔄 Upload 401 — refreshing token and retrying...');
    await refreshHiggsfieldToken();
    return uploadImageToHiggsfield(buffer, mimeType, false);
  }

  const initText = await initRes.text();
  if (!initRes.ok) throw new Error('Upload init failed: ' + initText.slice(0, 200));
  const { id, url, upload_url } = JSON.parse(initText);

  // Step 2: PUT actual bytes to S3 presigned URL
  const s3Res = await fetch(upload_url, {
    method:  'PUT',
    headers: { 'Content-Type': mimeType },
    body:    buffer,
  });
  if (!s3Res.ok) throw new Error('S3 upload failed: ' + s3Res.status);

  console.log('✓ Higgsfield media uploaded:', id);
  return { id, url };
}

// Appel REST direct — utilisé quand le CLI ne supporte pas l'option (ex: gpt_image_2 + image)
async function fetchHiggsFieldREST(payload, timeoutMs = 270_000) {
  // Read token dynamically so refresh within this call is picked up
  const apiKey = () => process.env.HIGGSFIELD_API_KEY || '';
  const { model, prompt, resolution, images } = payload;

  let input_images;
  if (Array.isArray(images) && images.length) {
    // Upload each image to Higgsfield and get media UUIDs
    input_images = await Promise.all(images.map(async (b64) => {
      const data   = b64.replace(/^data:image\/\w+;base64,/, '');
      const mime   = (b64.match(/^data:(image\/\w+);/) || [])[1] || 'image/jpeg';
      const buffer = Buffer.from(data, 'base64');
      const { id, url } = await uploadImageToHiggsfield(buffer, mime);
      return { id, url, type: 'media_input' };
    }));
  }

  const params = { prompt };
  if (resolution) params.resolution = resolution;
  if (input_images) {
    if (model === 'gpt_image_2') params.medias = input_images.map(img => ({ data: img, role: 'image' }));
    else params.input_images = input_images;
  }

  const body = { job_set_type: model, params };

  // Soumettre le job
  let submitRes = await fetch(`${HF_API}/agents/jobs`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (submitRes.status === 401) {
    console.log('🔄 Submit 401 — refreshing token and retrying...');
    await refreshHiggsfieldToken();
    submitRes = await fetch(`${HF_API}/agents/jobs`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.HIGGSFIELD_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  }

  const submitted = await submitRes.json();
  console.log('REST submit:', JSON.stringify(submitted).slice(0, 300));
  // API returns either ["jobId"] or {id: "jobId"}
  const jobId = Array.isArray(submitted) ? submitted[0] : submitted.id;
  if (!submitRes.ok || !jobId) throw new Error('REST submit failed: ' + JSON.stringify(submitted).slice(0, 200));
  const deadline = Date.now() + timeoutMs;

  // Poll jusqu'au résultat
  let lastStatus = 'queued';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    let pollRes = await fetch(`${HF_API}/agents/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${apiKey()}` },
    });
    // Token expiré pendant le polling : on rafraîchit et on continue (pas un échec)
    if (pollRes.status === 401) {
      console.log('🔄 Poll 401 — refreshing token mid-poll...');
      await refreshHiggsfieldToken().catch(() => {});
      continue;
    }
    const job = await pollRes.json();
    lastStatus = job.status || lastStatus;
    const url = job.result_url || (job.results && job.results[0] && job.results[0].url);
    console.log('REST poll:', job.status, url || '');
    if (job.status === 'completed' && url) return { imageUrl: url, jobId };
    // Statuts terminaux d'échec — on échoue tout de suite, sans attendre le timeout
    if (job.status === 'nsfw') throw new Error('NSFW_BLOCKED');
    if (job.status === 'failed' || job.status === 'canceled') throw new Error('Job failed: ' + JSON.stringify(job).slice(0, 200));
  }
  throw new Error('Timeout waiting for REST job (last status: ' + lastStatus + ')');
}

async function fetchHiggsfield(payload, nsfwMsg, timeoutMs = 270_000) {
  const model = MODEL_MAP[payload.model] || payload.model || 'nano_banana_2';
  return fetchHiggsFieldREST({ ...payload, model }, timeoutMs);
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
      HOME: PERSIST_DIR,
    };

    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env }, async (err, stdout, stderr) => {
      // Log complet pour diagnostic
      if (stdout) console.log('CLI stdout:', stdout.slice(0, 500));
      if (stderr) console.log('CLI stderr:', stderr.slice(0, 500));
      if (err)    console.log('CLI err.message:', err.message?.slice(0, 300));

      if (err) {
        const detail = (stderr || err.message || '').slice(0, 500);
        console.error('❌ CLI failed. Full detail:', detail);
        if (retry && /session expired/i.test(detail)) {
          console.log('🔄 Session expired — refreshing token and retrying...');
          refreshHiggsfieldToken()
            .then(() => runCLI(args, timeoutMs, false).then(resolve).catch(reject))
            .catch(e => reject(new Error('Token refresh failed: ' + e.message)));
          return;
        }
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
  // Deduplicate concurrent refresh calls
  if (_refreshInProgress) return _refreshInProgress;

  _refreshInProgress = new Promise((resolve, reject) => {
    const binName   = process.platform === 'win32' ? 'hf.exe' : 'hf';
    const vendorBin = path.join(__dirname, 'node_modules', '@higgsfield', 'cli', 'vendor', binName);
    const bin       = fs.existsSync(vendorBin) ? vendorBin : binName;

    // IMPORTANT : `auth token` n'affiche que le token stocké sans le rafraîchir.
    // Pour forcer un VRAI refresh, on lance un appel API authentifié léger
    // (`account status`). Si le token est expiré, le CLI le rafraîchit
    // automatiquement et réécrit credentials.json avec un token neuf.
    // HOME pointe vers PERSIST_DIR : le CLI lit/écrit le fichier persistant.
    execFile(bin, ['account', 'status'], { timeout: 30_000, env: { ...process.env, HOME: PERSIST_DIR } }, (err, stdout, stderr) => {
      _refreshInProgress = null;
      if (err) return reject(new Error('CLI account status failed: ' + (stderr || err.message).slice(0, 200)));

      // Le CLI a (potentiellement) réécrit credentials.json avec un token neuf : on le relit
      const creds = readPersistedCredentials();
      if (!creds || !creds.access_token) return reject(new Error('No credentials after refresh'));

      process.env.HIGGSFIELD_API_KEY = creds.access_token;
      if (creds.refresh_token) process.env.HIGGSFIELD_REFRESH_TOKEN = creds.refresh_token;
      console.log('✓ Higgsfield token refreshed via CLI (account status), new prefix =', creds.access_token.slice(0, 8));
      resolve();
    });
  });

  return _refreshInProgress;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Retourne un message d'erreur safe pour le client (jamais de détails techniques)
function clientError(err) {
  const msg = err.message || '';
  if (msg === 'NSFW_BLOCKED' || /nsfw|safety system|content[_ ]?policy|moderation/i.test(msg)) {
    return 'Ta description a été bloquée par le filtre de contenu de l\'IA. ' +
           'Reformule en évitant : nudité, corps dénudés, figures torse nu, violence, armes réalistes, sang ou symboles trop sensibles. ' +
           'Décris plutôt une figure habillée, en armure ou en drapé couvrant.';
  }
  if (/timeout/i.test(msg)) {
    return 'La génération a pris trop de temps (serveur Higgsfield surchargé). Réessaie dans un instant.';
  }
  return msg || 'Generation failed. Please try again in a moment.';
}

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ─────────────────────────────────────────────────
// OpenAI image generation — gpt-image-1 (best quality)
// ─────────────────────────────────────────────────
// Taille gpt-image-1 par format
function sizeForFormat(format) {
  return format === 'portrait' ? '1024x1536'
       : format === 'landscape' ? '1536x1024'
       : '1024x1024';
}
// Choisit le format gpt-image-1 selon la zone du corps
function openAISizeForZone(zone) {
  const tall = ['avant-bras', 'bras-complet', 'cuisse', 'mollet', 'dos'];
  if (tall.includes(zone)) return '1024x1536';   // portrait
  return '1024x1024';                              // carré (poitrine, épaule, main, défaut)
}

// Wrapper de rendu "flash de tatouage premium" (réutilisable)
function buildRenderWrapper(designPrompt, { bw = true } = {}) {
  const colorRule = bw
    ? `Pure neutral black & grey only — true blacks, neutral cool greys, pure white. No color, no sepia, no brown/cream/beige tint, no warm tone, no aged-paper look.`
    : `Clean saturated tattoo colors as described, no muddy tones.`;
  return (
    `Professional tattoo design presented as flat 2D tattoo flash on a pure solid white background (#FFFFFF). ` +
    `${designPrompt} ` +
    // ── Hiérarchie & retenue : injectées DANS le prompt image (la cause des rendus chargés) ──
    `COMPOSITION — THIS IS THE PRIORITY: one single clear dominant focal point with strong visual hierarchy. ` +
    `The focal subject carries the detail; any secondary element stays lighter, smaller and clearly subordinate. ` +
    `Generous clean negative space around and within the design — do NOT fill the canvas. ` +
    `Restraint over decoration: do NOT add ornaments, patterns, dotwork, geometry, banners, smoke, or background elements that were not explicitly requested. ` +
    `The design must read clearly from a distance with a strong, simple silhouette. ` +
    `RENDER: elite black-and-grey tattoo artist quality, crisp clean linework, smooth realistic shading, controlled contrast; detail concentrated only where it matters, edges breathing into white space. ${colorRule} ` +
    `This is the tattoo artwork ONLY — no photographic scene, no skin, no body, no frame, no mockup. ` +
    `Pure white background #FFFFFF (not cream, not off-white) around the whole design, no dark fill, no scenery, no shading behind the subject. ` +
    `Centered, full design visible, ready to be tattooed.`
  );
}

// Détecte si l'utilisateur demande explicitement de la couleur
function wantsColor(text) {
  return /\b(couleur|en couleur|color|colour|colored|coloured|colorful|colourful|vibrant colou?rs?|full colou?r)\b/i.test(text || '');
}

// Finition "studio" : contraste renforcé + netteté (+ noir & blanc si demandé)
async function finishImage(dataUrl, { grayscale = true } = {}) {
  try {
    const sharp = require('sharp');
    const b64 = (dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    if (!b64) return dataUrl;
    const buf = Buffer.from(b64, 'base64');
    let img = sharp(buf);
    if (grayscale) img = img.grayscale();
    img = img
      .normalise()                 // étire l'histogramme : noirs plus profonds, blancs plus purs
      .linear(1.08, -8)            // léger boost de contraste
      .sharpen({ sigma: 0.8 });    // netteté douce sur les lignes
    const out = await img.png().toBuffer();
    return 'data:image/png;base64,' + out.toString('base64');
  } catch (e) {
    console.warn('⚠ finishImage failed:', e.message);
    return dataUrl; // fallback : image telle quelle
  }
}

// ─────────────────────────────────────────────────
// Enrichit l'idée de l'utilisateur en un prompt détaillé DANS le style choisi
// (modèle texte gpt-4o-mini). Renvoie null si indisponible → fallback sur le prompt brut.
// Exemple few-shot : montre le NIVEAU de prompt attendu (gpt-4o calque la qualité)
const ENHANCE_FEWSHOT_USER = 'un loup';
const ENHANCE_FEWSHOT_ASSISTANT =
  `A single majestic wolf head as the clear, dominant central focal point, rendered in hyper-realistic black and grey with deep velvety blacks and smooth silvery shading. The fur is finely detailed only around the face and dissolves softly into clean white negative space toward the neck. The piercing eyes are the sharpest point of focus and anchor the whole composition. Strong directional lighting carves contrast and volume across the muzzle. Crisp single-needle linework on the silhouette, dense realistic shading concentrated at the core, the lower edges breathing into open white. No background, no ornaments, no added symbols or geometry — restrained, balanced and premium. A world-class black and grey tattoo flash on a pure white background, no color, no scenery.`;

async function enhancePrompt(userIdea, styleKey, extras = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey || !userIdea) return null;
  const style  = getStyle(styleKey);
  const mood   = AMBIANCE_MODIFIERS[extras.ambiance] || '';
  const zone   = ZONE_COMPOSITION[extras.zone] || '';
  const sys =
    `You are a world-class tattoo design prompt engineer for the gpt-image-1 image model, working for a luxury black & grey tattoo studio. ` +
    `Turn the user's idea into ONE single vivid, detailed image prompt for a flat tattoo DESIGN on a pure white background. ` +
    `Use STRICTLY pure neutral black and grey (true blacks, neutral greys, pure white) unless the user clearly asks for color — never sepia, never warm/brown/cream tones. ` +
    `Lead with these exact visual anchors and keep them dominant: ${style.keyMarkers}. ` +
    `Then stay strictly inside this style and these rules:\n\n` +
    `=== STYLE ===\n${style.recipe}\n\n` +
    `=== RULES ===\n${DESIGN_SYSTEM_PROMPT}\n\n` +
    (mood ? `=== MOOD ===\n${mood}\n\n` : '') +
    (zone ? `=== FORMAT ===\n${zone}\n\n` : '') +
    `Build the description around ONE single dominant focal point with a strong, clear visual hierarchy: the focal subject carries the detail, any secondary element stays lighter and clearly subordinate, and there is generous clean negative space. ` +
    `Show restraint — do NOT invent ornaments, patterns, geometry, symbols, banners, smoke or background elements that the user did not ask for; only describe what genuinely serves the idea. ` +
    `Concentrate detail where it matters and let the edges breathe into white space; the design must read clearly from a distance with a simple strong silhouette. ` +
    `SAFE FOR WORK: any human/figure must be fully clothed, draped or in armor — no nudity, no bare chest, no exposed skin emphasis; no graphic gore, blood or explicit violence; weapons only as stylized ornamental elements. ` +
    `Match the restraint, clear hierarchy and structure of the example answer. ` +
    `Output ONLY the final image prompt in English (80-140 words), no preamble, no quotes, no lists.`;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: ENHANCE_FEWSHOT_USER },
          { role: 'assistant', content: ENHANCE_FEWSHOT_ASSISTANT },
          { role: 'user', content: userIdea },
        ],
        temperature: 0.7, max_tokens: 450,
      }),
    });
    const data = await resp.json();
    const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return out ? out.trim() : null;
  } catch (e) {
    console.warn('⚠ enhancePrompt failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────
// QUALITY CHECKER — vérifie le rendu (vision gpt-4o). Fail-open : en cas d'erreur, on valide.
async function qualityCheck(dataUrl, { bw = true } = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey || !dataUrl || !dataUrl.startsWith('data:')) return { pass: true, reason: '' };
  try {
    const checklist =
      `You are a strict QA reviewer for a premium tattoo design generator. Judge if this image is a VALID, clean, high-quality tattoo flash design. ` +
      `It MUST: be a flat tattoo design only (NOT a photo of skin/body, NOT a mockup, NOT a framed picture), sit on a pure WHITE background, ` +
      (bw ? `be pure black & grey with NO color and NO sepia/warm/cream tint, ` : `have clean, well-controlled colors, `) +
      `show a clear readable subject, and look tattooable and professional. ` +
      `Reply with STRICT JSON only: {"pass": true|false, "reason": "<short>"}. Set pass=false ONLY if it clearly violates one of the must-haves.`;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [ { role: 'user', content: [
          { type: 'text', text: checklist },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] } ],
        temperature: 0, max_tokens: 80,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await resp.json();
    const txt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
    const parsed = JSON.parse(txt);
    return { pass: parsed.pass !== false, reason: parsed.reason || '' };
  } catch (e) {
    console.warn('⚠ qualityCheck failed:', e.message);
    return { pass: true, reason: '' }; // fail-open : ne jamais bloquer une image valide
  }
}

async function generateWithOpenAI(prompt, referenceImagePath = null, size = '1024x1024') {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('OPENAI_API_KEY not set.');

  if (referenceImagePath) {
    // With reference: use edits endpoint
    const fd = new FormData();
    fd.append('model', 'gpt-image-1');
    fd.append('prompt', prompt);
    fd.append('n', '1');
    fd.append('size', size);
    fd.append('quality', 'high');
    const refIsPng = referenceImagePath.toLowerCase().endsWith('.png');
    fd.append('image[]', new File([fs.readFileSync(referenceImagePath)], `reference.${refIsPng ? 'png' : 'jpg'}`, { type: refIsPng ? 'image/png' : 'image/jpeg' }));

    const resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error('OpenAI edits error: ' + JSON.stringify(data).slice(0, 300));
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image returned from OpenAI edits');
    return `data:image/png;base64,${b64}`;

  } else {
    // Text-only: use generations endpoint
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size, quality: 'high' }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error('OpenAI generations error: ' + JSON.stringify(data).slice(0, 300));
    const b64 = data.data?.[0]?.b64_json;
    const url  = data.data?.[0]?.url;
    if (b64) return `data:image/png;base64,${b64}`;
    if (url) return url;
    throw new Error('No image returned from OpenAI generations');
  }
}

// Édition gpt-image-1 avec PLUSIEURS images d'entrée (ex: photo du corps + design)
async function openAIEditMulti(prompt, imagePaths = [], size = 'auto') {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('OPENAI_API_KEY not set.');

  const fd = new FormData();
  fd.append('model', 'gpt-image-1');
  fd.append('prompt', prompt);
  fd.append('n', '1');
  fd.append('size', size);
  fd.append('quality', 'high');
  imagePaths.forEach((p, i) => {
    const isPng = p.toLowerCase().endsWith('.png');
    fd.append('image[]', new File([fs.readFileSync(p)], `img${i}.${isPng ? 'png' : 'jpg'}`, { type: isPng ? 'image/png' : 'image/jpeg' }));
  });

  const resp = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: fd,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('OpenAI edits error: ' + JSON.stringify(data).slice(0, 300));
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned from OpenAI edits');
  return `data:image/png;base64,${b64}`;
}

// ─────────────────────────────────────────────────
// POST /rework — Inpainting précis via OpenAI gpt-image-1
// ─────────────────────────────────────────────────
app.post('/rework', upload.fields([{ name: 'image' }, { name: 'mask' }, { name: 'fusion' }]), async (req, res) => {
  const prompt    = (req.body.prompt    || '').trim();
  const zoneDesc  = (req.body.zoneDesc  || '').trim();
  const imageFile = req.files?.image?.[0];
  const maskFile  = req.files?.mask?.[0];
  const fusionFile = req.files?.fusion?.[0];

  if (!prompt || !imageFile) {
    return res.status(400).json({ error: 'Missing prompt or image.' });
  }

  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });

  try {
    const fusionNote = fusionFile ? ' Fuse the style and elements of the reference fusion image with the original design.' : '';
    const fullPrompt = `Tattoo design. ${zoneDesc ? zoneDesc + ' ' : ''}${prompt}.${fusionNote} Keep the same artistic style, line weight and composition for all areas outside the mask. Professional tattoo flash art, white background, high resolution.`;
    console.log('\n🎨 Rework via OpenAI inpainting');
    console.log('   Prompt:', fullPrompt.slice(0, 120));

    const fd = new FormData();
    fd.append('model', 'gpt-image-1');
    fd.append('prompt', fullPrompt);
    fd.append('size', '1024x1024');
    fd.append('quality', 'high');
    fd.append('n', '1');

    const imgBuffer = fs.readFileSync(imageFile.path);
    fd.append('image[]', new File([imgBuffer], 'design.png', { type: 'image/png' }));
    if (fusionFile) {
      const fusionBuffer = fs.readFileSync(fusionFile.path);
      fd.append('image[]', new File([fusionBuffer], 'fusion.png', { type: 'image/png' }));
    }

    if (maskFile) {
      const maskBuffer = fs.readFileSync(maskFile.path);
      fd.append('mask', new File([maskBuffer], 'mask.png', { type: 'image/png' }));
    }

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    });

    const data = await response.json();
    console.log('OpenAI response status:', response.status);

    // Si OpenAI échoue (billing, quota…) → fallback sur nano_banana_2
    if (!response.ok) {
      console.warn('⚠️ OpenAI failed, falling back to nano_banana_2:', data.error?.message);
      const b64img = fs.readFileSync(imageFile.path).toString('base64');
      const fallbackImages = [`data:image/png;base64,${b64img}`];
      if (fusionFile) fallbackImages.push(`data:image/png;base64,${fs.readFileSync(fusionFile.path).toString('base64')}`);
      const fallbackPayload = {
        model: 'gpt_image_2',
        prompt: `${fullPrompt}`,
        images: fallbackImages,
        resolution: '2k',
      };
      const { imageUrl } = await fetchHiggsfield(fallbackPayload);
      return res.json({ imageUrl, fallback: true });
    }

    const b64 = data.data?.[0]?.b64_json;
    const url  = data.data?.[0]?.url;
    if (!b64 && !url) throw new Error('No image in OpenAI response');

    let imageUrl = url;
    if (b64 && !url) {
      const outPath = path.join(os.tmpdir(), `rework-${Date.now()}.png`);
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
      imageUrl = `/rework-result/${path.basename(outPath)}`;
      setTimeout(() => { try { fs.unlinkSync(outPath); } catch {} }, 10 * 60 * 1000);
      app._reworkTmp = app._reworkTmp || {};
      app._reworkTmp[path.basename(outPath)] = outPath;
    }

    res.json({ imageUrl });
  } catch (err) {
    console.error('❌ /rework:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (imageFile  && fs.existsSync(imageFile.path))  try { fs.unlinkSync(imageFile.path);  } catch {}
    if (maskFile   && fs.existsSync(maskFile.path))   try { fs.unlinkSync(maskFile.path);   } catch {}
    if (fusionFile && fs.existsSync(fusionFile.path)) try { fs.unlinkSync(fusionFile.path); } catch {}
  }
});

// Sert les résultats rework temporaires (base64 → fichier local)
app.get('/rework-result/:filename', (req, res) => {
  const p = (app._reworkTmp || {})[req.params.filename];
  if (!p || !fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/png');
  res.send(fs.readFileSync(p));
});

// ─────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ═══════════════════════════════════════════════════
// AUTH — Google vérifié serveur + session cookie + comptes DB
// ═══════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const GOOGLE_CLIENT_ID = '1055204918844-a5kshvsbciibcak84plhf007trpc0k59.apps.googleusercontent.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ink-studio-dev-secret-change-me';
const SESSION_COOKIE = 'ink_sid';

function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, SESSION_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function getSessionUser(req) {
  if (!db) return null;
  const tok = getCookie(req, SESSION_COOKIE);
  if (!tok) return null;
  try {
    const { uid } = jwt.verify(tok, SESSION_SECRET);
    const r = await db.query('SELECT * FROM users WHERE id=$1', [uid]);
    return r.rows[0] || null;
  } catch { return null; }
}
function publicUser(u) {
  return u && {
    email: u.email, name: u.name, avatar: u.avatar_url,
    plan: u.plan, credits: u.credits_remaining,
    creditsMax: PLAN_CREDITS[u.plan] || PLAN_CREDITS.free,
    creditsResetAt: u.credits_reset_at,
  };
}

// Recharge mensuelle automatique des crédits selon le plan
async function applyMonthlyReset(user) {
  if (!db || !user) return user;
  if (new Date(user.credits_reset_at) > new Date()) return user;
  const amount = PLAN_CREDITS[user.plan] || PLAN_CREDITS.free;
  const r = await db.query(
    `UPDATE users SET credits_remaining=$1, credits_reset_at = now() + interval '30 days' WHERE id=$2 RETURNING *`,
    [amount, user.id]
  );
  return r.rows[0];
}

// Débite des crédits ; renvoie le solde restant
async function chargeCredits(userId, cost) {
  const r = await db.query(
    `UPDATE users SET credits_remaining = GREATEST(credits_remaining - $1, 0) WHERE id=$2 RETURNING credits_remaining`,
    [cost, userId]
  );
  return r.rows[0] ? r.rows[0].credits_remaining : null;
}

// Dossier persistant des images générées (volume Railway)
const GENS_DIR = path.join(PERSIST_DIR, 'gens');
try { fs.mkdirSync(GENS_DIR, { recursive: true }); } catch {}

// Sauvegarde une génération : écrit l'image sur le volume + ligne en DB. Renvoie l'URL fichier.
async function saveGeneration(userId, type, dataUrl, params) {
  if (!db || !userId || !dataUrl || !dataUrl.startsWith('data:')) return null;
  try {
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const name = Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.png';
    fs.writeFileSync(path.join(GENS_DIR, name), Buffer.from(b64, 'base64'));
    const url = '/gens/' + name;
    await db.query(
      `INSERT INTO generations (user_id, type, image_url, params) VALUES ($1,$2,$3,$4)`,
      [userId, type, url, params ? JSON.stringify(params) : null]
    );
    return url;
  } catch (e) {
    console.warn('⚠ saveGeneration failed:', e.message);
    return null;
  }
}

// Connexion via Google (le front envoie le credential GSI)
app.post('/auth/google', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB indisponible' });
  const credential = req.body && req.body.credential;
  if (!credential) return res.status(400).json({ error: 'credential manquant' });
  try {
    // Vérifie le token Google
    const v = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    const p = await v.json();
    if (!v.ok || !p.email || (p.aud !== GOOGLE_CLIENT_ID)) {
      return res.status(401).json({ error: 'Token Google invalide' });
    }
    // Upsert user
    const r = await db.query(
      `INSERT INTO users (email, google_id, name, avatar_url, credits_remaining)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET google_id=EXCLUDED.google_id, name=EXCLUDED.name, avatar_url=EXCLUDED.avatar_url
       RETURNING *`,
      [p.email, p.sub, p.name || p.email.split('@')[0], p.picture || null, PLAN_CREDITS.free]
    );
    const user = r.rows[0];
    setSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('❌ /auth/google:', e.message);
    res.status(500).json({ error: 'Auth échouée' });
  }
});

// Profil de l'utilisateur connecté
app.get('/me', async (req, res) => {
  let u = await getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'non connecté' });
  u = await applyMonthlyReset(u);
  res.json({ user: publicUser(u) });
});

// Déconnexion
app.post('/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

// Images générées (volume persistant)
app.use('/gens', express.static(GENS_DIR));

// Historique de l'utilisateur connecté
app.get('/projects', async (req, res) => {
  const u = await getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'non connecté' });
  try {
    const r = await db.query(
      `SELECT id, type, image_url, params, created_at FROM generations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 60`,
      [u.id]
    );
    res.json({ projects: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Suppression d'un projet
app.delete('/projects/:id', async (req, res) => {
  const u = await getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'non connecté' });
  try {
    await db.query('DELETE FROM generations WHERE id=$1 AND user_id=$2', [req.params.id, u.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic base de données (temporaire)
app.get('/db-health', async (req, res) => {
  if (!db) return res.json({ connected: false, reason: 'DATABASE_URL non défini' });
  try {
    const t = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','generations') ORDER BY table_name`);
    const u = await db.query('SELECT count(*)::int AS n FROM users');
    res.json({ connected: true, tables: t.rows.map(r => r.table_name), users: u.rows[0].n });
  } catch (e) {
    res.json({ connected: false, reason: e.message });
  }
});

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

    if (inspFile) {
      inspPath = inspFile.path + '.jpg';
      fs.renameSync(inspFile.path, inspPath);
    }

    // ── Crédits : connexion requise + solde suffisant (si DB active) ──
    let sessionUser = null;
    const creditCost = CREDIT_COST.design;
    if (db) {
      sessionUser = await getSessionUser(req);
      if (!sessionUser) return res.status(401).json({ error: 'login_required' });
      sessionUser = await applyMonthlyReset(sessionUser);
      if (sessionUser.credits_remaining < creditCost) {
        return res.status(402).json({ error: 'no_credits', credits: sessionUser.credits_remaining });
      }
    }

    let imageUrl, jobId = null, finalPrompt = prompt;

    if (process.env.OPENAI_API_KEY) {
      // ── Génération via OpenAI gpt-image-1 (rapide & stable) ──
      console.log('   Moteur  : OpenAI gpt-image-1');
      // Format : zone si fournie, sinon format par défaut du style
      const size = zone ? openAISizeForZone(zone) : sizeForFormat(getStyle(style).defaultFormat);
      const bw   = !wantsColor(sujet) && !getStyle(style).colorByDefault;

      // Enrichissement automatique du prompt DANS le style choisi (sauf free prompt brut)
      let designPrompt = prompt;
      if (!freePrompt) {
        const enhanced = await enhancePrompt(sujet, style, { ambiance, zone });
        if (enhanced) { designPrompt = enhanced; console.log('   ✨ Prompt enrichi (style', style + ')'); }
      }

      // Wrapper de rendu premium (réutilisable)
      const openaiPrompt = buildRenderWrapper(designPrompt, { bw });

      // ── Log du PROMPT FINAL EXACT envoyé à gpt-image-1 (audit / debug) ──
      finalPrompt = openaiPrompt;
      console.log('   📐 Taille :', size, '| N&B :', bw);
      console.log('   ──────── PROMPT FINAL → gpt-image-1 ────────');
      console.log(openaiPrompt);
      console.log('   ─────────────────────────────────────────────');

      // Génération unique (pas de régénération auto : on ne risque jamais de remplacer
      // une bonne image par une moins bonne). Le Quality Checker reste dispo si besoin.
      let img = await generateWithOpenAI(openaiPrompt, inspPath, size);
      imageUrl = await finishImage(img, { grayscale: bw });
      console.log(bw ? '   ⚫ Rendu N&B' : '   🎨 Rendu couleur');
    } else {
      // ── Fallback : Higgsfield ──
      console.log('   Moteur  : Higgsfield (fallback)');
      const payload = inspFile
        ? { model: 'gpt_image_2', prompt, images: [fileToBase64(inspPath)], resolution: '2k' }
        : { model: 'gpt_image_2', prompt };
      const r = await fetchHiggsfield(payload,
        'La génération a été bloquée par le filtre du modèle.\n' +
        'Essaie de reformuler ta description.');
      imageUrl = r.imageUrl; jobId = r.jobId;
    }

    // Débit des crédits + sauvegarde en historique après succès
    let creditsLeft = null;
    if (db && sessionUser) {
      creditsLeft = await chargeCredits(sessionUser.id, creditCost);
      await saveGeneration(sessionUser.id, 'design', imageUrl, { sujet, style, ambiance, zone, finalPrompt });
    }

    res.json({ imageUrl, jobId, prompt, zone, credits: creditsLeft, finalPrompt });

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

    const ZONE_BODYPART = {
      'avant-bras': 'forearm', 'bras-complet': 'arm', 'epaule': 'shoulder',
      'dos': 'back', 'pectoral': 'chest', 'cuisse': 'thigh', 'mollet': 'calf', 'main': 'hand',
    };
    const bodyPart = ZONE_BODYPART[zone] || 'body';

    // Prompt officiel utilisateur (préservation pixel-identique de la photo), rendu adaptable à la zone.
    // IMAGE 1 = photo du corps, IMAGE 2 = design.
    const prompt =
      `You are given two images: IMAGE 1 is a real photograph of a person, IMAGE 2 is a tattoo design on a white background. ` +
      `Edit only the ${bodyPart} skin area of IMAGE 1. Preserve the original photograph exactly as it is. ` +
      `Do not modify the person's pose, anatomy, lighting, colors, clothing, background, camera angle, or image composition. ` +
      `Apply the provided tattoo design from IMAGE 2 exactly as given, without redesigning or simplifying it. ` +
      `Warp the tattoo naturally to match the curvature of the ${bodyPart}, adjust opacity and skin texture realistically, and blend it as if it were a real healed black-and-grey tattoo. ` +
      `Keep the tattoo entirely on bare skin — never on clothing, fabric or background. ` +
      `The rest of the image must remain pixel-identical to the original photograph.`;

    // Récupère les octets du design (data URL OpenAI ou http) dans un fichier temporaire
    let designPath;
    if (designUrl.startsWith('data:')) {
      const designBuf = Buffer.from(designUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      designPath = path.join(os.tmpdir(), `design-${Date.now()}.png`);
      fs.writeFileSync(designPath, designBuf);
    } else {
      const dlRes = await fetch(designUrl);
      if (!dlRes.ok) throw new Error('Impossible de récupérer le design: ' + dlRes.status);
      const designBuf = Buffer.from(await dlRes.arrayBuffer());
      designPath = path.join(os.tmpdir(), `design-${Date.now()}.png`);
      fs.writeFileSync(designPath, designBuf);
    }

    console.log('   Moteur : OpenAI gpt-image-1 (edit photo + design)');
    let imageUrl;
    try {
      // gpt-image-1 edits avec 2 images : la photo du corps + le design
      imageUrl = await openAIEditMulti(prompt, [photoPath, designPath], 'auto');
    } finally {
      if (designPath && fs.existsSync(designPath)) fs.unlinkSync(designPath);
    }

    try {
      const su = await getSessionUser(req);
      if (su) await saveGeneration(su.id, 'on-body', imageUrl, { zone, model: 'gpt-image-1' });
    } catch {}

    res.json({ imageUrl, jobId: null, model: 'gpt-image-1' });

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
      model:      'gpt_image_2',
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

    // gpt-image-1 edit : design de tatouage inspiré de la photo, fond blanc
    const petPrompt =
      `${prompt} Flat 2D tattoo flash design isolated on a pure solid white background (#FFFFFF), ` +
      `no photographic scene, no dark background. Centered, full design visible, clean crisp linework.`;
    const imageUrl = await openAIEditMulti(petPrompt, [photoPath], '1024x1024');

    try {
      const su = await getSessionUser(req);
      if (su) await saveGeneration(su.id, 'pet', imageUrl, { style, details, zone });
    } catch {}

    res.json({ imageUrl, zone });

  } catch (err) {
    console.error('❌ /generate-pet-tattoo :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
});

// ─────────────────────────────────────────────────
// POST /stencil — Outil Stencil via gpt-image-1 (photo → stencil Spirit violet)
// File  : image
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/stencil', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY non configurée.' });

  const imgPath = req.file.path + '.png';
  fs.renameSync(req.file.path, imgPath);

  try {
    console.log('\n🖊 Stencil via OpenAI gpt-image-1');
    const imageUrl = await openAIEditMulti(STENCIL_PROMPT, [imgPath], 'auto');
    try {
      const su = await getSessionUser(req);
      if (su) await saveGeneration(su.id, 'stencil', imageUrl, {});
    } catch {}
    res.json({ imageUrl });
  } catch (err) {
    console.error('❌ /stencil :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
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
    console.log(`\n⚡ Merge tattoos — ${tmpFiles.length} designs, style: ${style}`);

    const mergePrompt =
      `${prompt} Flat 2D tattoo flash design on a pure solid white background (#FFFFFF), ` +
      `no photographic scene, no dark background, centered, clean crisp linework.`;
    const imageUrl = await openAIEditMulti(mergePrompt, tmpFiles, '1024x1024');

    try {
      const su = await getSessionUser(req);
      if (su) await saveGeneration(su.id, 'merge', imageUrl, { style, details, count: base64Images.length });
    } catch {}

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
// Remove background (remove.bg)
// ─────────────────────────────────────────────────
app.post('/remove-bg', upload.single('image'), async (req, res) => {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'REMOVE_BG_API_KEY not configured' });

  const file = req.file;
  const imageUrl = req.body.imageUrl;

  if (!file && !imageUrl) return res.status(400).json({ error: 'image or imageUrl required' });

  try {
    const FormData = require('form-data');
    const https = require('https');

    const form = new FormData();
    form.append('size', 'auto');
    if (file) {
      form.append('image_file', fs.createReadStream(file.path), { filename: file.originalname });
    } else {
      form.append('image_url', imageUrl);
    }

    const result = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.remove.bg',
        path: '/v1.0/removebg',
        method: 'POST',
        headers: { ...form.getHeaders(), 'X-Api-Key': apiKey },
      };
      const chunks = [];
      const reqHttp = https.request(opts, r => {
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          if (r.statusCode !== 200) {
            const body = Buffer.concat(chunks).toString();
            return reject(new Error('remove.bg error: ' + body.slice(0, 200)));
          }
          resolve(Buffer.concat(chunks));
        });
      });
      reqHttp.on('error', reject);
      form.pipe(reqHttp);
    });

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', 'attachment; filename="transparent.png"');
    res.send(result);
  } catch (err) {
    console.error('❌ /remove-bg:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (file) try { fs.unlinkSync(file.path); } catch {}
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
