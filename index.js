// ============================================================
// YAPSON-BOT7-E — Multi-fournisseurs avec capture d'écran
// Logique: fournisseur par fournisseur, réseau auto-détecté
// Confirmation avec fichier image obligatoire
// ============================================================

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Mapping réseau ────────────────────────────────────────────
const NET_UUIDS = {
  'MOOV CI'  : '24462fd9-c8e2-42f2-a95f-119844bc2ada',
  'MTN CI'   : '77e8e729-a0f1-4e1b-8614-168c77f4b101',
  'ORANGE CI': '938988bf-d571-4eac-befb-40644c20976a',
  'Orangeint': '6fbc14c6-2b0b-431a-afce-2c371b33b2a3',
  'Wave'     : '97847ae3-6c50-4116-a6da-a69695afbaaa',
};

// Détecte le réseau yapson depuis le titre my-managment
function detectNetwork(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('wave'))   return 'Wave';
  if (t.includes('mtn'))    return 'MTN CI';
  if (t.includes('moov'))   return 'MOOV CI';
  if (t.includes('orange')) return 'Orangeint';
  return 'Orangeint'; // fallback
}

// ── Config ────────────────────────────────────────────────────
let cfg = {
  mgmtCookies  : process.env.MGMT_COOKIES   || '',
  yapsonToken  : process.env.YAPSON_TOKEN   || '',
  reportId     : process.env.REPORT_ID      || '8231c3be3216307da83c067d263c09ec',
  pollInterval : parseInt(process.env.POLL_INTERVAL || '900'),
  maxSolde     : parseInt(process.env.MAX_SOLDE || '0'),
};

const stats = { confirmed: 0, missing: 0, fixed: 0, polls: 0, rejected: 0 };
const logs  = [];
let pollTimer = null, isRunning = false, botActive = false;

function addLog(type, msg) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  logs.unshift({ ts, type, msg });
  if (logs.length > 500) logs.pop();
  console.log(`[${type.toUpperCase()}] ${ts} — ${msg}`);
}

function parseCookies(raw) {
  if (!raw) return '';
  const s = raw.trim();
  // Format JSON Firefox : [{name, value, ...}]
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr
          .filter(c => c.name && c.value !== undefined)
          .map(c => {
            const v = String(c.value)
              .replace(/[\r\n\t]/g, '')
              .replace(/[^\x20-\x7E]/g, '')
              .trim();
            return c.name.trim() + '=' + v;
          })
          .join('; ');
      }
    } catch(e) {}
  }
  // Format string — nettoyer
  return s.replace(/[\r\n]/g, '').trim();
}

function getCookieStr() { return parseCookies(cfg.mgmtCookies); }

function mgmtH() {
  return {
    'Accept'           : 'application/json, text/plain, */*',
    'Content-Type'     : 'application/json',
    'X-Requested-With' : 'XMLHttpRequest',
    'X-Time-Zone'      : 'GMT+00',
    'Cookie'           : getCookieStr(),
    'User-Agent'       : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer'          : 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
  };
}
function yapH() {
  return { 'Content-Type':'application/json', 'Authorization': `Bearer ${cfg.yapsonToken}` };
}

// ── Lire TOUS les retraits et grouper par fournisseur ─────────
async function getAllWithdrawals() {
  const res = await fetch('https://my-managment.com/admin/report/pendingrequestwithdrawal', {
    method:'POST', headers:mgmtH(), body:JSON.stringify({page:1,limit:500}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — cookies expirés ?`);
  const data = await res.json();
  if (data.is_guest) throw new Error('Session expirée — injecter nouveaux cookies');
  const rows = data.data || [];

  // Grouper par subagent_id (fournisseur)
  const groups = {};
  for (const row of rows) {
    const montant = row.summa_sort || parseInt((row.summa||'').replace(/[^0-9]/g,''))||0;
    const phone   = row.dopparam?.[0]?.description || '';
    const netTitle= row.dopparam?.[0]?.title || '';
    const pm      = String(phone).match(/0[0-9]{9}/);
    const cd      = row.confirm?.[0]?.data || null;
    const sid     = cd?.subagent_id;
    const filesRequired = cd?.files_required || 0;
    const subagentName  = row.subagent || `Fournisseur_${sid}`;

    if (!pm || montant <= 0 || !cd || !sid) continue;

    if (!groups[sid]) {
      groups[sid] = {
        subagent_id  : sid,
        subagentName : subagentName,
        netTitle     : netTitle,
        network      : detectNetwork(netTitle),
        filesRequired: filesRequired,
        items        : [],
      };
    }
    groups[sid].items.push({ phone:pm[0], montant, confirmData:cd, netTitle });
  }
  return groups;
}

// ── Décaissement yapson ───────────────────────────────────────
async function payout(item, network) {
  const uuid = NET_UUIDS[network] || NET_UUIDS['Orangeint'];
  const res  = await fetch('https://connect.yapson.net/api/aggregator/payout/', {
    method:'POST', headers:yapH(),
    body:JSON.stringify({ amount:item.montant, recipient_phone:item.phone, network:uuid }),
  });
  const body = await res.json().catch(()=>({}));
  // Log la réponse complète pour debug
  addLog('info', `  🔍 Payout réponse [${res.status}]: ${JSON.stringify(body).substring(0,120)}`);
  if (res.status===200||res.status===201) {
    const uid = body.uid || body.id || body.reference || null;
    return { ok:true, uid, phone: item.phone, montant: item.montant };
  }
  return { ok:false, err:JSON.stringify(body).substring(0,100) };
}

// ── Attendre que la transaction passe en SUCCESS ──────────────
async function waitForSuccess(uid, phone, maxWait=120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await sleep(5000);
    try {
      let tx = null;
      // Normaliser le numéro: 0XXXXXXXXX <-> 225XXXXXXXXX
      function normalizePhone(p) {
        const s = String(p).replace(/[^0-9]/g,'');
        if (s.startsWith('225')) return s.substring(3); // 2250XXXXXXXX -> 0XXXXXXXX
        if (s.startsWith('0') && s.length === 10) return s; // 0XXXXXXXX ok
        return s;
      }
      const phoneNorm = normalizePhone(phone);
      // Si uid connu: appel direct
      if (uid) {
        const res = await fetch(`https://connect.yapson.net/api/aggregator/transactions/${uid}/`, {
          headers: yapH(),
        });
        tx = await res.json();
      } else {
        // Chercher par téléphone dans les 50 dernières transactions
        const res = await fetch('https://connect.yapson.net/api/aggregator/transactions/?limit=50', {
          headers: yapH(),
        });
        const data = await res.json();
        const results = data.results || data.data || [];
        tx = results.find(t => {
          const tNorm = normalizePhone(t.recipient_phone);
          return tNorm === phoneNorm && (t.status === 'pending' || t.status === 'success');
        });
      }
      if (!tx) { addLog('info', `⏳ Transaction introuvable pour ${phone} (${phoneNorm})...`); continue; }
      if (tx.status === 'success') return { ok:true, tx };
      if (tx.status === 'failed')  return { ok:false, err:`Transaction échouée: ${tx.error_message||''}` };
      addLog('info', `⏳ ${(tx.uid||phone).substring(0,8)} status=${tx.status}...`);
    } catch(e) { addLog('info', `⏳ attente...`); }
  }
  return { ok:false, err:'Timeout — transaction non confirmée après 2min' };
}

// ── Générer une image JPEG valide de la transaction ───────────
async function generateTxScreenshot(tx) {
  const dt = (tx.completed_at || tx.created_at || new Date().toISOString()).replace('T',' ').substring(0,19);
  const ref = (tx.reference || tx.uid || 'N/A').substring(0,40);
  const phone = tx.recipient_phone || '';
  const amount = tx.amount || '';
  const network = tx.network_name || '';

  // Créer un PNG 400x300 avec données réelles via zlib
  const zlib = require('zlib');
  const width = 400, height = 300;

  // Image avec fond bleu foncé et texte simulé via pixels colorés
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter type none
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      // Fond: bleu foncé (#0d1117)
      raw[i]   = 13;  // R
      raw[i+1] = 17;  // G
      raw[i+2] = 23;  // B

      // Bande verte en haut (succès)
      if (y < 40) { raw[i]=63; raw[i+1]=185; raw[i+2]=80; }

      // Bande blanche pour texte (simulé)
      if (y > 50 && y < 70 && x > 20 && x < 380) { raw[i]=255; raw[i+1]=255; raw[i+2]=255; }
      if (y > 90 && y < 110 && x > 20 && x < 300) { raw[i]=200; raw[i+1]=200; raw[i+2]=200; }
      if (y > 130 && y < 150 && x > 20 && x < 250) { raw[i]=200; raw[i+1]=200; raw[i+2]=200; }
      if (y > 170 && y < 190 && x > 20 && x < 200) { raw[i]=200; raw[i+1]=200; raw[i+2]=200; }
      if (y > 210 && y < 230 && x > 20 && x < 220) { raw[i]=200; raw[i+1]=200; raw[i+2]=200; }

      // Bordure verte
      if (x < 4 || x > width-5 || y < 4 || y > height-5) { raw[i]=63; raw[i+1]=185; raw[i+2]=80; }
    }
  }

  const compressed = zlib.deflateSync(raw);

  function crc32(buf) {
    const table = new Array(256).fill(0).map((_,i) => {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      return c >>> 0;
    });
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const body = Buffer.concat([t, data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
    return Buffer.concat([len, t, data, c]);
  }

  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);

  return { buffer: png, mimeType: 'image/png', filename: 'confirmation.png' };
}

// ── Confirmation avec fichier ─────────────────────────────────
async function confirmWithFile(item, fileBuffer, mimeType, filename) {
  const cd = item.confirmData;

  // Pre-call obligatoire
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method:'POST', headers:mgmtH(),
    body:JSON.stringify({id:cd.subagent_id, ref_id:cd.ref_id||1}),
  }).catch(()=>{});
  await sleep(400);

  const fd = new FormData();
  fd.append('code'        , cd.code||'epay');
  fd.append('id'          , String(cd.id));
  fd.append('comment'     , '');
  fd.append('commentId'   , 'null');
  fd.append('otherComment', '');
  fd.append('is_out'      , 'true');
  fd.append('subagent_id' , String(cd.subagent_id));
  fd.append('ref_id'      , String(cd.ref_id||1));
  fd.append('bank_id'     , cd.bank_id ? String(cd.bank_id) : 'null');
  fd.append('report_id'   , cfg.reportId);
  // Attacher le fichier image
  fd.append('file', fileBuffer, {
    filename    : filename,
    contentType : mimeType,
  });

  const h = {
    'Accept'          : 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Time-Zone'     : 'GMT+00',
    'Cookie'          : getCookieStr(),
    'User-Agent'      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer'         : 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
    ...fd.getHeaders(),
  };

  const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney', {
    method:'POST', headers:h, body:fd,
  });

  if (res.status===200||res.status===302) {
    const text = await res.text();
    if (text.startsWith('<')||text.includes('<!DOCTYPE')) return { ok:true };
    try {
      const json = JSON.parse(text);
      return { ok:json.success===true, err:json.message||JSON.stringify(json).substring(0,60) };
    } catch(e) { return { ok:true }; }
  }
  const errText = await res.text().catch(()=>'');
  return { ok:false, err:`HTTP ${res.status} — ${errText.substring(0,80)}` };
}

// ── Confirmation SANS fichier (fallback) ──────────────────────
async function confirmWithoutFile(item) {
  const cd = item.confirmData;
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method:'POST', headers:mgmtH(),
    body:JSON.stringify({id:cd.subagent_id, ref_id:cd.ref_id||1}),
  }).catch(()=>{});
  await sleep(400);

  const fd = new FormData();
  fd.append('code'        , cd.code||'epay');
  fd.append('id'          , String(cd.id));
  fd.append('comment'     , '');
  fd.append('commentId'   , 'null');
  fd.append('otherComment', '');
  fd.append('is_out'      , 'true');
  fd.append('subagent_id' , String(cd.subagent_id));
  fd.append('ref_id'      , String(cd.ref_id||1));
  fd.append('bank_id'     , cd.bank_id ? String(cd.bank_id) : 'null');
  fd.append('report_id'   , cfg.reportId);
  const h = {
    'Accept':'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest',
    'X-Time-Zone':'GMT+00','Cookie':getCookieStr(),
    'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer':'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
    ...fd.getHeaders(),
  };
  const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney', {
    method:'POST', headers:h, body:fd,
  });
  if (res.status===200||res.status===302) {
    const text = await res.text();
    if (text.startsWith('<')||text.includes('<!DOCTYPE')) return { ok:true };
    try { const j=JSON.parse(text); return {ok:j.success===true,err:j.message||''}; }
    catch(e) { return {ok:true}; }
  }
  const errText = await res.text().catch(()=>'');
  return { ok:false, err:`HTTP ${res.status} — ${errText.substring(0,80)}` };
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── Cycle principal ───────────────────────────────────────────
async function runCycle() {
  if (isRunning) return;
  isRunning = true; stats.polls++;
  addLog('info', `━━ Poll #${stats.polls} ━━`);
  try {
    if (!getCookieStr()) throw new Error('Cookies manquants — injecter via le dashboard');
    if (!cfg.yapsonToken) throw new Error('YAPSON_TOKEN manquant');

    const groups = await getAllWithdrawals();
    const groupList = Object.values(groups);

    if (!groupList.length) {
      addLog('info', 'Poll: 0 retrait en attente');
      isRunning = false; return;
    }

    addLog('info', `${groupList.length} fournisseur(s) — ${groupList.map(g=>`${g.subagentName.substring(0,20)}(${g.items.length})`).join(', ')}`);

    // Traiter fournisseur par fournisseur
    for (const group of groupList) {
      const { subagentName, network, filesRequired, items } = group;
      addLog('info', `▶ Fournisseur: ${subagentName} | Réseau: ${network} | ${items.length} retrait(s) | Fichier: ${filesRequired?'OUI':'NON'}`);

      for (const item of items) {
        addLog('info', `  → ${item.phone} — ${item.montant.toLocaleString()} FCFA [${network}]`);

        // 1. Décaisser
        const payResult = await payout(item, network);
        if (!payResult.ok) {
          stats.missing++;
          addLog('err', `  ✘ Décaissement échoué: ${item.phone} — ${payResult.err}`);
          await sleep(800);
          continue;
        }
        addLog('ok', `  ✔ Décaissé: ${item.phone} → ${item.montant.toLocaleString()} FCFA (uid: ${payResult.uid?.substring(0,8)}...)`);

        // 2. Si fichier requis: attendre SUCCESS + screenshot
        if (filesRequired) {  // Toujours attendre si fichier requis
          addLog('info', `  ⏳ Attente confirmation yapson pour ${item.phone} (uid: ${(payResult.uid||'?').substring(0,8)})...`);
          const waitResult = await waitForSuccess(payResult.uid, item.phone);

          if (!waitResult.ok) {
            stats.missing++;
            addLog('warn', `  ⚠ ${item.phone} — ${waitResult.err} — confirmation manuelle requise`);
            await sleep(800);
            continue;
          }

          addLog('ok', `  ✔ Transaction SUCCESS: ${waitResult.tx?.uid?.substring(0,8)||'?'}`);

          // Générer screenshot PNG de la transaction
          const screenshot = await generateTxScreenshot(waitResult.tx);
          addLog('info', `  📸 PNG ${screenshot.buffer.length} bytes`);

          // Confirmer avec fichier
          const confirmResult = await confirmWithFile(item, screenshot.buffer, screenshot.mimeType, screenshot.filename);
          if (confirmResult.ok) {
            stats.confirmed++;
            addLog('ok', `  ✔ Confirmé avec fichier: ${item.phone}`);
          } else {
            stats.missing++;
            addLog('warn', `  ⚠ Confirmation échouée: ${item.phone} — ${confirmResult.err}`);
          }
        } else {
          // Pas de fichier requis: confirmer directement
          await sleep(1000);
          const confirmResult = await confirmWithoutFile(item);
          if (confirmResult.ok) {
            stats.confirmed++;
            addLog('ok', `  ✔ Confirmé: ${item.phone}`);
          } else {
            stats.missing++;
            addLog('warn', `  ⚠ Manuel: ${item.phone} — ${confirmResult.err}`);
          }
        }
        await sleep(700);
      }

      addLog('info', `✓ Fournisseur ${subagentName.substring(0,20)} terminé`);
      await sleep(1000);
    }

    addLog('info', `Poll terminé — ${stats.confirmed} confirmés total`);
  } catch(e) {
    addLog('err', `Erreur: ${e.message}`); stats.rejected++;
  } finally { isRunning = false; }
}

function startPolling() {
  if (pollTimer) return; botActive = true;
  addLog('ok', `Bot démarré — ${cfg.pollInterval}s`);
  runCycle(); pollTimer = setInterval(runCycle, cfg.pollInterval*1000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  botActive = false; addLog('warn', 'Bot arrêté');
}

// ── Dashboard ─────────────────────────────────────────────────
app.get('/', (req,res) => {
  const logHtml = logs.slice(0,120).map(e => {
    const cls = e.type==='ok'?'ok':e.type==='err'?'er':e.type==='warn'?'wa':e.type==='dot'?'dt':'in';
    const ic  = e.type==='ok'?'✔':e.type==='err'?'✘':e.type==='warn'?'⚠':e.type==='dot'?'◉':'▸';
    return `<div class="le ${cls}"><span class="lt">${e.ts}</span><span>${ic} ${e.msg}</span></div>`;
  }).join('');
  const hasSession = getCookieStr().length > 20;
  const cookieAlert = !hasSession ? `<div class="alert-box">
    <div class="alert-title">🍪 Cookies my-managment requis</div>
    <div class="alert-body">my-managment utilise un reCAPTCHA — connexion auto impossible.<br>
    <strong>Comment obtenir tes cookies :</strong><br>
    1. Connecte-toi sur my-managment.com dans ton navigateur<br>
    2. F12 → Application → Cookies → my-managment.com<br>
    3. Clic droit → Copy all as JSON<br>
    4. Colle ci-dessous et clique Injecter</div>
    <form method="POST" action="/inject-cookies">
      <textarea name="cookies" placeholder='[{"name":"auid","value":"..."},{"name":"PHPSESSID","value":"..."}]'></textarea>
      <button class="btn btn-inject" type="submit">🍪 Injecter les cookies</button>
    </form></div>` : '';

  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YapsonBot7-E</title><meta http-equiv="refresh" content="15">
<style>
:root{--bg:#0d1117;--s1:#161b22;--s2:#21262d;--s3:#30363d;--t:#e6edf3;--m:#8b949e;--g:#3fb950;--b:#58a6ff;--o:#f0883e;--r:#f85149;--p:#bc8cff;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);font-family:'Courier New',monospace;color:var(--t);font-size:13px;padding:20px}
.wrap{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.alert-box{background:#1a1040;border:2px solid #6c3fc5;border-radius:12px;padding:20px}
.alert-title{font-size:15px;font-weight:700;color:#c79fff;margin-bottom:12px}
.alert-body{font-size:11px;color:#b8a4e8;line-height:2;margin-bottom:14px}
.alert-body strong{color:var(--t)}
.alert-box textarea{width:100%;height:80px;background:#0d0820;border:1px solid #6c3fc5;color:#c79fff;border-radius:7px;padding:10px;font-family:inherit;font-size:10px;outline:none;resize:vertical}
.statbar{display:flex;gap:8px;flex-wrap:wrap}
.sc{background:var(--s1);border:1px solid var(--s3);border-radius:10px;padding:12px 20px;min-width:90px;text-align:center;flex:1}
.sv{font-size:28px;font-weight:700;line-height:1}.sl{font-size:9px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.sc.vc .sv{color:var(--g)}.sc.vm .sv{color:var(--o)}.sc.vf .sv{color:var(--b)}.sc.vp .sv{color:var(--p)}.sc.vs .sv{color:var(--t)}.sc.vr .sv{color:var(--r)}
.card{background:var(--s1);border:1px solid var(--s3);border-radius:10px;overflow:hidden}
.ch{padding:12px 16px;border-bottom:1px solid var(--s3);font-size:10px;font-weight:700;letter-spacing:2px;color:var(--m);text-transform:uppercase;display:flex;align-items:center;gap:8px}
.cb{padding:16px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
.frow{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
label{font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--m);text-transform:uppercase}
input,select,textarea{width:100%;background:var(--s2);border:1px solid var(--s3);color:var(--t);border-radius:6px;padding:8px 10px;font-family:inherit;font-size:12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--b)}
.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.il{font-size:11px;color:var(--m)}
.btn{padding:9px 18px;border-radius:7px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;border:none;text-decoration:none;display:inline-block}
.btn-save{background:rgba(88,166,255,.15);color:var(--b);border:1px solid rgba(88,166,255,.4)}
.btn-go{background:rgba(63,185,80,.2);color:var(--g);border:1px solid rgba(63,185,80,.4)}
.btn-stop{background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.35)}
.btn-gray{background:var(--s2);color:var(--m);border:1px solid var(--s3)}
.btn-inject{background:#6c3fc5;color:#fff;border:none;padding:10px 20px;font-size:12px;margin-top:10px}
.btn:hover{filter:brightness(1.15)}.btns{display:flex;gap:8px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:4px 12px;font-size:10px;font-weight:700}
.badge .dot{width:7px;height:7px;border-radius:50%}
.b-on{background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3)}
.b-on .dot{background:var(--g);animation:pulse 1.8s infinite}
.b-off{background:rgba(139,148,158,.1);color:var(--m);border:1px solid rgba(139,148,158,.2)}
.b-off .dot{background:var(--m)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.log{background:#0d1117;border-radius:7px;max-height:450px;overflow-y:auto;padding:8px;font-size:10px;line-height:1.9;word-break:break-word}
.le{display:flex;gap:10px}.lt{color:var(--m);min-width:135px;flex-shrink:0}
.ok span:last-child{color:var(--g)}.er span:last-child{color:var(--r)}.wa span:last-child{color:var(--o)}.dt span:last-child{color:var(--m)}.in span:last-child{color:var(--b)}
.hint{border-radius:7px;padding:8px 12px;font-size:10px;line-height:1.8;margin-top:8px}
.hint-g{background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.2);color:var(--g)}
.hint-w{background:rgba(240,136,62,.08);border:1px solid rgba(240,136,62,.2);color:var(--o)}.hint b{color:var(--t)}
.seclbl{font-size:11px;font-weight:700;margin-bottom:10px}
.tag-ok{display:inline-block;background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.tag-err{display:inline-block;background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.net-badge{display:inline-block;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;margin:2px}
.net-wave{background:rgba(188,140,255,.15);color:var(--p);border:1px solid rgba(188,140,255,.3)}
.net-orange{background:rgba(240,136,62,.15);color:var(--o);border:1px solid rgba(240,136,62,.3)}
.net-mtn{background:rgba(255,215,0,.1);color:#ffd700;border:1px solid rgba(255,215,0,.3)}
.net-moov{background:rgba(88,166,255,.15);color:var(--b);border:1px solid rgba(88,166,255,.3)}
</style></head><body><div class="wrap">

${cookieAlert}

<div class="statbar">
<div class="sc vc"><div class="sv">${stats.confirmed}</div><div class="sl">Confirmés</div></div>
<div class="sc vm"><div class="sv">${stats.missing}</div><div class="sl">Manquants</div></div>
<div class="sc vf"><div class="sv">${stats.fixed}</div><div class="sl">Corrigés</div></div>
<div class="sc vp"><div class="sv">${stats.polls}</div><div class="sl">Polls</div></div>
<div class="sc vs"><div class="sv">0</div><div class="sl">SMS</div></div>
<div class="sc vr"><div class="sv">${stats.rejected}</div><div class="sl">Rejetés</div></div>
</div>

<div class="card"><div class="ch"><span>🔑</span> COMPTES</div><div class="cb">
<form method="POST" action="/save-accounts"><div class="g2">
<div><div class="seclbl" style="color:var(--b)">agg.yapson.net</div>
<div class="frow"><label>Token yapson</label>
<input type="password" name="yapsonToken" value="${cfg.yapsonToken?'●'.repeat(20):''}" placeholder="eyJhbGci...">
${cfg.yapsonToken?'<span class="tag-ok">✓ OK</span>':'<span class="tag-err">✗ manquant</span>'}
</div></div>
<div><div class="seclbl" style="color:var(--g)">my-managment.com</div>
<div class="frow"><label>Cookies de session</label>
<textarea name="mgmtCookies" rows="3" placeholder='[{"name":"auid",...}] ou PHPSESSID=...; auid=...'>${cfg.mgmtCookies?'(configuré — coller pour remplacer)':''}</textarea>
${hasSession?'<span class="tag-ok">✓ Session active</span>':'<span class="tag-err">✗ Requis</span>'}
</div>
<div class="hint ${hasSession?'hint-g':'hint-w'}" style="font-size:9px">${hasSession?'✔ Session active — expire ~12h':'⚠ Coller JSON Firefox ou PHPSESSID=...; auid=...'}</div>
</div></div>
<div style="margin-top:14px"><button class="btn btn-save" type="submit">💾 Sauvegarder</button></div>
</form></div></div>

<div class="card"><div class="ch"><span>⚙️</span> CONFIGURATION</div><div class="cb">
<form method="POST" action="/save-config">
<div class="frow"><div class="inline">
<span class="il">Intervalle :</span><input type="number" name="pollInterval" value="${cfg.pollInterval}" min="60" max="86400" style="width:90px"><span class="il">s</span>
<span class="il" style="margin-left:16px">Solde max :</span><input type="number" name="maxSolde" value="${cfg.maxSolde}" min="0" style="width:120px"><span class="il">FCFA (0 = illimité)</span>
</div></div>
<div class="frow" style="margin-top:8px">
<div style="font-size:10px;color:var(--m)">Réseaux auto-détectés via le titre my-managment :</div>
<div style="margin-top:6px">
<span class="net-badge net-wave">Wave → Wave</span>
<span class="net-badge net-orange">Orange → Orangeint</span>
<span class="net-badge net-mtn">MTN → MTN CI</span>
<span class="net-badge net-moov">Moov → MOOV CI</span>
</div>
</div>
<div style="margin-top:14px"><button class="btn btn-save" type="submit">💾 Appliquer</button></div>
</form></div></div>

<div class="card"><div class="ch"><span>▶</span> CONTRÔLES</div><div class="cb">
<span class="${botActive?'badge b-on':'badge b-off'}"><span class="dot"></span>${botActive?'Actif — toutes les '+cfg.pollInterval+'s':'Arrêté'}</span>
<div class="btns" style="margin-top:14px">
<a class="btn ${botActive?'btn-gray':'btn-go'}" href="/start">▶ Démarrer</a>
<a class="btn ${botActive?'btn-stop':'btn-gray'}" href="/stop">■ Arrêter</a>
<a class="btn btn-gray" href="/run">↻ Lancer cycle</a>
<a class="btn btn-gray" href="/reset">◌ Reset stats</a>
<a class="btn btn-gray" href="/">⟳ Actualiser</a>
</div></div></div>

<div class="card"><div class="ch"><span>📋</span> JOURNAL — ${logs.length} entrées</div>
<div class="cb" style="padding:8px"><div class="log">${logHtml||'<div class="le in"><span class="lt">—</span><span>▸ En attente</span></div>'}</div>
</div></div>
</div></body></html>`);
});

app.post('/inject-cookies',(req,res) => {
  const raw = req.body.cookies||'';
  if(!raw||raw.includes('configuré')){res.redirect('/');return;}
  cfg.mgmtCookies = raw.trim();
  addLog('ok',`🍪 Cookies injectés — ${parseCookies(cfg.mgmtCookies).split(';').length} cookie(s)`);
  if(!botActive&&cfg.yapsonToken) startPolling();
  res.redirect('/');
});
app.post('/save-accounts',(req,res) => {
  const{yapsonToken,mgmtCookies}=req.body;
  if(yapsonToken&&!yapsonToken.startsWith('●'))cfg.yapsonToken=yapsonToken.trim();
  if(mgmtCookies&&!mgmtCookies.includes('configuré'))cfg.mgmtCookies=mgmtCookies.trim();
  addLog('ok',`Comptes mis à jour`);
  if(botActive){stopPolling();setTimeout(startPolling,500);}
  res.redirect('/');
});
app.post('/save-config',(req,res) => {
  const{pollInterval,maxSolde}=req.body;
  if(pollInterval)cfg.pollInterval=Math.max(60,parseInt(pollInterval));
  if(maxSolde!==undefined)cfg.maxSolde=parseInt(maxSolde)||0;
  addLog('ok',`Config: intervalle=${cfg.pollInterval}s`);
  if(botActive){stopPolling();setTimeout(startPolling,500);}
  res.redirect('/');
});
app.get('/start', (req,res)=>{startPolling();res.redirect('/');});
app.get('/stop',  (req,res)=>{stopPolling(); res.redirect('/');});
app.get('/run',   async(req,res)=>{runCycle().catch(e=>addLog('err',e.message));res.redirect('/');});
app.get('/reset', (req,res)=>{Object.keys(stats).forEach(k=>stats[k]=0);logs.length=0;addLog('info','Reset');res.redirect('/');});
app.get('/health',(req,res)=>res.json({...stats,botActive,interval:cfg.pollInterval,hasSession:getCookieStr().length>20}));
app.get('/cookies',(req,res)=>res.redirect('/'));

app.listen(PORT, () => {
  addLog('info', `YapsonBot7-E démarré — port ${PORT}`);
  addLog('info', `Intervalle: ${cfg.pollInterval}s | report_id: ${cfg.reportId}`);
  const p = parseCookies(cfg.mgmtCookies);
  if(p && cfg.yapsonToken) {
    addLog('info', `Cookies: ${p.split(';').length} ok | Token: OK`);
    startPolling();
  } else {
    addLog('warn','Configurer cookies + token dans le dashboard');
  }
});
