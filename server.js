const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, PageBreak, TabStopPosition, TabStopType, Leader
} = require('docx');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const OPENAI_KEY    = process.env.OPENAI_API_KEY  || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const EMAIL_USER    = process.env.EMAIL_USER  || 'graficalucel@gmail.com';
const EMAIL_PASS    = process.env.EMAIL_PASS  || '';
const WHATS_NUM     = process.env.WHATS_NUM   || '5511934964127';
const BASE_URL      = process.env.BASE_URL    || 'http://localhost:3000';
const ADMIN_KEY     = process.env.ADMIN_KEY   || 'lucel2026';

const jobs = {};

// ── ADMIN AUTH ─────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ erro: 'Não autorizado' });
  next();
}

// ── 1. CLIENTE CADASTRA PEDIDO (aguarda pagamento) ────────────────────────
app.post('/api/pedido', async (req, res) => {
  const { youtubeUrl, nome, email, whatsapp } = req.body;
  if (!youtubeUrl || !email) return res.status(400).json({ erro: 'URL e e-mail obrigatórios.' });

  const jobId = Date.now().toString();
  jobs[jobId] = {
    status: 'aguardando_pagamento',
    progresso: 0,
    mensagem: '⏳ Aguardando confirmação do pagamento...',
    nome, email, whatsapp, youtubeUrl,
    criadoEm: new Date().toISOString()
  };

  // Avisar admin
  notificarAdmin(jobId).catch(() => {});

  res.json({ jobId });
});

// ── 2. ADMIN CONFIRMA PAGAMENTO E DISPARA PROCESSAMENTO ──────────────────
app.post('/api/admin/liberar/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Job não encontrado' });

  job.status = 'iniciando';
  job.progresso = 0;
  job.mensagem = 'Iniciando processamento...';
  res.json({ ok: true });

  processarVideo(req.params.jobId).catch(err => {
    jobs[req.params.jobId].status = 'erro';
    jobs[req.params.jobId].mensagem = '❌ ' + err.message;
  });
});

// ── 3. ADMIN PROCESSA MANUALMENTE (sem pedido prévio) ────────────────────
app.post('/api/admin/processar', adminAuth, async (req, res) => {
  const { youtubeUrl, nome, email, whatsapp } = req.body;
  if (!youtubeUrl || !email) return res.status(400).json({ erro: 'URL e e-mail obrigatórios.' });

  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'iniciando', progresso: 0, mensagem: 'Iniciando...', nome, email, whatsapp, youtubeUrl, criadoEm: new Date().toISOString() };
  res.json({ jobId });

  processarVideo(jobId).catch(err => {
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ ' + err.message;
  });
});

// ── 4. STATUS ─────────────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Job não encontrado' });
  res.json(job);
});

// ── 5. DOWNLOAD ───────────────────────────────────────────────────────────
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.docxPath) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(job.docxPath, job.nomeArquivo || 'livro.docx');
});

// ── ADMIN ROTAS ───────────────────────────────────────────────────────────
app.get('/api/admin/jobs', adminAuth, (req, res) => res.json(jobs));

app.post('/api/admin/reenviar/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  await Promise.allSettled([enviarEmail(job, req.params.jobId), enviarWhatsapp(job, req.params.jobId)]);
  res.json({ ok: true });
});

app.delete('/api/admin/excluir/:jobId', adminAuth, (req, res) => {
  delete jobs[req.params.jobId];
  res.json({ ok: true });
});

// ── PROCESSAMENTO ─────────────────────────────────────────────────────────
async function processarVideo(jobId) {
  const job = jobs[jobId];
  const tmpDir = `/tmp/job_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // ETAPA 1 — Baixar áudio
    atualizar(jobId, 'baixando', 10, '⏬ Baixando áudio do YouTube...');
    const audioTemplate = path.join(tmpDir, 'audio.%(ext)s');

    try {
      await execAsync(`yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${audioTemplate}" "${job.youtubeUrl}"`);
    } catch(e) {
      throw new Error('Falha ao baixar vídeo: ' + (e.stderr || e.message).substring(0, 200));
    }

    const files = fs.readdirSync(tmpDir);
    const audioFile = files.find(f => /\.(mp3|m4a|webm|opus|ogg)$/.test(f));
    if (!audioFile) throw new Error('Arquivo de áudio não encontrado após download.');
    const audioFinal = path.join(tmpDir, audioFile);

    // Verificar tamanho — Whisper aceita até 25MB
    const sizeMB = fs.statSync(audioFinal).size / (1024 * 1024);
    let audioEnviar = audioFinal;
    if (sizeMB > 23) {
      atualizar(jobId, 'baixando', 18, '✂️ Otimizando áudio...');
      const audioCorte = path.join(tmpDir, 'audio_corte.mp3');
      await execAsync(`ffmpeg -i "${audioFinal}" -t 3600 -acodec libmp3lame -ab 64k "${audioCorte}" -y`);
      audioEnviar = audioCorte;
    }

    // ETAPA 2 — Transcrever
    atualizar(jobId, 'transcrevendo', 30, '🎙️ Transcrevendo o áudio...');
    const transcricao = await transcreverAudio(audioEnviar);
    if (!transcricao || transcricao.length < 50) throw new Error('Transcrição muito curta ou falhou.');

    // ETAPA 3 — Gerar livro
    atualizar(jobId, 'gerando', 55, '🤖 Criando os 12 capítulos com IA...');
    const livro = await gerarLivro(transcricao, job.nome);

    // ETAPA 4 — Diagramar
    atualizar(jobId, 'diagramando', 80, '📐 Diagramando o livro...');
    const docxPath = path.join(tmpDir, 'livro.docx');
    await gerarDocx(livro, docxPath);

    const nomeArquivo = livro.titulo.replace(/[^a-zA-Z0-9À-ú ]/g, '_').substring(0, 40) + '.docx';
    job.docxPath = docxPath;
    job.nomeArquivo = nomeArquivo;
    job.titulo = livro.titulo;

    // ETAPA 5 — Notificar
    atualizar(jobId, 'notificando', 92, '📲 Enviando notificações...');
    await Promise.allSettled([enviarEmail(job, jobId), enviarWhatsapp(job, jobId)]);

    atualizar(jobId, 'pronto', 100, '✅ Livro pronto para download!');

  } catch(err) {
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ ' + err.message;
    throw err;
  } finally {
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    }, 7200000); // limpa após 2h
  }
}

function atualizar(jobId, status, progresso, mensagem) {
  jobs[jobId] = { ...jobs[jobId], status, progresso, mensagem };
  console.log(`[${jobId}] ${mensagem}`);
}

// ── WHISPER ───────────────────────────────────────────────────────────────
async function transcreverAudio(audioPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('model', 'whisper-1');
  form.append('language', 'pt');
  form.append('response_format', 'text');

  const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` },
    maxBodyLength: Infinity,
    timeout: 300000
  });
  return resp.data;
}

// ── GERAR LIVRO COM CLAUDE ────────────────────────────────────────────────
async function gerarLivro(transcricao, nomeAutor) {
  const prompt = `Você é um escritor e editor profissional brasileiro. Com base na transcrição abaixo de um vídeo do YouTube, crie um livro completo em português com exatamente 12 capítulos. Melhore a linguagem falada para escrita literária fluente. Corrija erros. Cada capítulo deve ter pelo menos 3 parágrafos completos. Responda APENAS em JSON válido sem texto extra:
{"titulo":"string","subtitulo":"string","autor":"${nomeAutor || 'Autor'}","capitulos":[{"numero":1,"titulo":"string","texto":"paragrafo1\\n\\nparagrafo2\\n\\nparagrafo3"}]}

TRANSCRIÇÃO:
${transcricao.substring(0, 12000)}`;

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    timeout: 120000
  });

  const texto = resp.data.content[0].text;
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('IA não retornou JSON válido');
  return JSON.parse(match[0]);
}

// ── GERAR DOCX ────────────────────────────────────────────────────────────
async function gerarDocx(livro, outputPath) {
  const FONT_T = 'Bebas Neue';
  const FONT_C = 'Palatino Linotype';
  const children = [];

  // Rosto
  children.push(
    new Paragraph({ children: [new TextRun({ text: livro.titulo.toUpperCase(), font: FONT_T, size: 80, bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 2000 } }),
    new Paragraph({ children: [new TextRun({ text: livro.subtitulo || '', font: FONT_C, size: 36, italics: true })], alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: '— —', font: FONT_C, size: 28 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: (livro.autor || 'Autor').toUpperCase(), font: FONT_T, size: 44 })], alignment: AlignmentType.CENTER, spacing: { before: 400 } }),
    new Paragraph({ children: [new PageBreak()] })
  );

  // Sumário
  children.push(new Paragraph({ children: [new TextRun({ text: 'SUMÁRIO', font: FONT_T, size: 48 })], alignment: AlignmentType.CENTER, spacing: { before: 400, after: 400 } }));
  (livro.capitulos || []).forEach(cap => {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: `${cap.numero}. ${cap.titulo}`, font: FONT_C, size: 24 }),
        new TextRun({ text: '\t', font: FONT_C }),
        new TextRun({ text: `${cap.numero + 1}`, font: FONT_C, size: 24 })
      ],
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: Leader.DOT }],
      spacing: { before: 80, after: 60 }
    }));
  });
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Capítulos
  (livro.capitulos || []).forEach(cap => {
    children.push(
      new Paragraph({ children: [new TextRun({ text: `CAPÍTULO ${cap.numero}`, font: FONT_T, size: 28, color: '888888' })], spacing: { before: 400, after: 100 } }),
      new Paragraph({ children: [new TextRun({ text: cap.titulo.toUpperCase(), font: FONT_T, size: 48 })], spacing: { after: 400 } })
    );
    (cap.texto || '').split('\n\n').filter(p => p.trim()).forEach(p => {
      children.push(new Paragraph({
        children: [new TextRun({ text: p.trim(), font: FONT_C, size: 24 })],
        alignment: AlignmentType.JUSTIFIED,
        indent: { firstLine: 720 },
        spacing: { line: 276, after: 0 }
      }));
    });
    children.push(new Paragraph({ children: [new PageBreak()] }));
  });

  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 7938, height: 11906 }, margin: { top: 992, bottom: 992, left: 1134, right: 1134 } } }, children }]
  });

  fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
}

// ── EMAIL ─────────────────────────────────────────────────────────────────
async function enviarEmail(job, jobId) {
  if (!EMAIL_PASS || !job.email) return;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: job.email,
    subject: `📚 Seu livro "${job.titulo || 'YouTube → Livro'}" está pronto!`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#111;color:#F5F0E8;padding:40px;border-radius:12px;">
      <h1 style="color:#C9A84C;">Lucel Digital</h1>
      <h2>Seu livro está pronto! 🎉</h2>
      <p>Olá, ${job.nome || 'autor'}!<br><br>Seu livro <strong style="color:#C9A84C;">"${job.titulo || ''}"</strong> foi gerado e está disponível para download.</p>
      <a href="${BASE_URL}/api/download/${jobId}" style="display:inline-block;background:#C9A84C;color:#000;font-weight:bold;padding:16px 40px;border-radius:6px;text-decoration:none;margin-top:16px;">📥 Baixar meu livro (.docx)</a>
      <p style="font-size:12px;color:#888;margin-top:32px;">Lucel Digital · graficalucel@gmail.com · (11) 93496-4127</p>
    </div>`
  });
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────
async function enviarWhatsapp(job, jobId) {
  if (!job.whatsapp) return;
  const num = job.whatsapp.replace(/\D/g, '');
  const msg = `🎉 *Olá, ${job.nome || 'autor'}!*\n\nSeu livro *"${job.titulo || 'YouTube → Livro'}"* ficou pronto!\n\n📥 Baixe agora:\n${BASE_URL}/api/download/${jobId}\n\n_Lucel Digital_`;
  const link = `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
  console.log('WhatsApp link gerado:', link);
}

// ── NOTIFICAR ADMIN ───────────────────────────────────────────────────────
async function notificarAdmin(jobId) {
  if (!EMAIL_PASS) return;
  const job = jobs[jobId];
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: EMAIL_USER,
    subject: `💰 Novo pedido aguardando pagamento — ${job.nome || job.email}`,
    html: `<div style="font-family:Arial,sans-serif;padding:32px;background:#111;color:#F5F0E8;border-radius:12px;">
      <h2 style="color:#C9A84C;">Novo pedido recebido!</h2>
      <p><b>Nome:</b> ${job.nome || '-'}<br>
      <b>Email:</b> ${job.email}<br>
      <b>WhatsApp:</b> ${job.whatsapp || '-'}<br>
      <b>Vídeo:</b> ${job.youtubeUrl}</p>
      <p>Após confirmar o pagamento de R$ 49,90, acesse o admin para liberar o processamento:</p>
      <a href="${BASE_URL}/admin.html" style="display:inline-block;background:#C9A84C;color:#000;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;">Abrir Admin →</a>
    </div>`
  });
}

// ── INDEX ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Lucel Digital rodando na porta ${PORT}`));
