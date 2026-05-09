const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, PageBreak, TabStopPosition, TabStopType, Leader
} = require('docx');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Upload em memória
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ASSEMBLY_KEY  = process.env.ASSEMBLYAI_API_KEY || '';
const EMAIL_USER    = process.env.EMAIL_USER || 'graficalucel@gmail.com';
const EMAIL_PASS    = process.env.EMAIL_PASS || '';
const BASE_URL      = process.env.BASE_URL   || 'http://localhost:3000';
const ADMIN_KEY     = process.env.ADMIN_KEY  || 'lucel2026';

const jobs = {};

// ── AUTH ───────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ erro: 'Não autorizado' });
  next();
}

// ── PÁGINAS ───────────────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── CLIENTE: REGISTRAR PEDIDO ─────────────────────────────────────────────
app.post('/api/pedido', async (req, res) => {
  const { youtubeUrl, nome, email, whatsapp } = req.body;
  if (!email) return res.status(400).json({ erro: 'E-mail obrigatório.' });
  const jobId = Date.now().toString();
  jobs[jobId] = {
    status: 'aguardando_pagamento',
    progresso: 0,
    mensagem: '⏳ Aguardando confirmação do pagamento...',
    nome, email, whatsapp, youtubeUrl,
    criadoEm: new Date().toISOString()
  };
  notificarAdmin(jobId).catch(() => {});
  res.json({ jobId });
});

// ── STATUS ────────────────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  res.json(job);
});

// ── DOWNLOAD ──────────────────────────────────────────────────────────────
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.docxBuffer)
    return res.status(404).send('Arquivo não encontrado.');
  res.setHeader('Content-Disposition', `attachment; filename="${job.nomeArquivo || 'livro.docx'}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.send(job.docxBuffer);
});

// ── ADMIN ─────────────────────────────────────────────────────────────────
app.get('/api/admin/jobs', adminAuth, (req, res) => res.json(jobs));

app.post('/api/admin/confirmar/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  job.status = 'pagamento_confirmado';
  job.mensagem = '✅ Pagamento confirmado. Aguardando upload do MP3...';
  await avisarInicio(job, req.params.jobId).catch(() => {});
  res.json({ ok: true });
});

// ── ADMIN: UPLOAD MP3 → TRANSCREVE → GERA LIVRO ──────────────────────────
app.post('/api/admin/upload/:jobId', adminAuth, upload.single('audio'), async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });

  job.status = 'transcrevendo';
  job.progresso = 20;
  job.mensagem = '⏫ Enviando áudio para transcrição...';

  const audioBuffer = req.file.buffer;

  // Responde imediatamente em JSON (resolve o erro "Unexpected token <")
  res.json({ ok: true });

  // Processa em background
  processarComAudioBuffer(jobId, audioBuffer).catch(err => {
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ ' + err.message;
  });
});

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

// ── PROCESSAR: AUDIO BUFFER → ASSEMBLY → CLAUDE → DOCX → EMAIL ──────────
async function processarComAudioBuffer(jobId, audioBuffer) {
  const job = jobs[jobId];

  try {
    // 1. Upload para AssemblyAI
    atualizar(jobId, 'transcrevendo', 25, '⏫ Enviando áudio para AssemblyAI...');
    const headers = { 'authorization': ASSEMBLY_KEY };
    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000
    });
    const audioUrl = uploadResp.data.upload_url;
    if (!audioUrl) throw new Error('AssemblyAI não retornou URL');

    // 2. Submeter transcrição
    atualizar(jobId, 'transcrevendo', 35, '🎙️ Transcrevendo o áudio...');
    const submit = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: audioUrl,
      language_code: 'pt'
    }, { headers: { ...headers, 'content-type': 'application/json' }, timeout: 30000 });

    const transcriptId = submit.data.id;
    if (!transcriptId) throw new Error('AssemblyAI não retornou ID');

    // 3. Aguardar conclusão
    let transcricao = '';
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers, timeout: 15000 });
      if (poll.data.status === 'completed') { transcricao = poll.data.text; break; }
      if (poll.data.status === 'error') throw new Error('AssemblyAI: ' + poll.data.error);
    }
    if (!transcricao || transcricao.length < 50) throw new Error('Transcrição falhou ou retornou vazia');

    // 4. Gerar livro com Claude
    atualizar(jobId, 'gerando', 60, '🤖 Criando os 12 capítulos com IA...');
    const livro = await gerarLivro(transcricao, job.nome);

    // 5. Gerar DOCX em buffer
    atualizar(jobId, 'diagramando', 82, '📐 Diagramando o livro...');
    const docxBuffer = await gerarDocxBuffer(livro);

    const nomeArquivo = (livro.titulo || 'livro').replace(/[^a-zA-Z0-9À-ú ]/g, '_').substring(0, 40) + '.docx';
    job.docxBuffer = docxBuffer;
    job.nomeArquivo = nomeArquivo;
    job.titulo = livro.titulo;

    // 6. Enviar por e-mail
    atualizar(jobId, 'notificando', 93, '📲 Enviando livro por e-mail...');
    await Promise.allSettled([
      enviarEmail(job, jobId),
      enviarWhatsapp(job, jobId)
    ]);

    atualizar(jobId, 'pronto', 100, '✅ Livro enviado por e-mail!');

  } catch(err) {
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ ' + err.message;
    throw err;
  }
}

function atualizar(jobId, status, progresso, mensagem) {
  jobs[jobId] = { ...jobs[jobId], status, progresso, mensagem };
  console.log(`[${jobId}] ${mensagem}`);
}

// ── GERAR LIVRO COM CLAUDE ────────────────────────────────────────────────
async function gerarLivro(transcricao, nomeAutor) {
  const prompt = `Você é um escritor e editor profissional brasileiro. Com base na transcrição abaixo de um vídeo do YouTube, crie um livro completo em português com exatamente 12 capítulos. Melhore a linguagem falada para escrita literária fluente. Corrija erros. Cada capítulo deve ter pelo menos 3 parágrafos completos. Responda APENAS em JSON válido sem texto extra:

{"titulo":"string","subtitulo":"string","autor":"${nomeAutor || 'Autor'}","capitulos":[{"numero":1,"titulo":"string","texto":"paragrafo1\\n\\nparagrafo2\\n\\nparagrafo3"}]}

TRANSCRIÇÃO:
${transcricao.substring(0, 12000)}`;

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-5',
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

// ── GERAR DOCX EM BUFFER ──────────────────────────────────────────────────
async function gerarDocxBuffer(livro) {
  const FONT_T = 'Bebas Neue';
  const FONT_C = 'Palatino Linotype';
  const children = [];

  // Capa
  children.push(
    new Paragraph({ children: [new TextRun({ text: (livro.titulo || '').toUpperCase(), font: FONT_T, size: 80, bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 2000 } }),
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
      new Paragraph({ children: [new TextRun({ text: (cap.titulo || '').toUpperCase(), font: FONT_T, size: 48 })], spacing: { after: 400 } })
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
  return await Packer.toBuffer(doc);
}

// ── EMAIL COM ANEXO ───────────────────────────────────────────────────────
async function enviarEmail(job, jobId) {
  if (!EMAIL_PASS || !job.email || !job.docxBuffer) return;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: job.email,
    subject: `📚 Seu livro "${job.titulo || 'YouTube → Livro'}" está pronto!`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#111;color:#F5F0E8;padding:40px;border-radius:12px;">
      <h1 style="color:#C9A84C;">Lucel Digital</h1>
      <h2>Seu livro está pronto! 🎉</h2>
      <p>Olá, ${job.nome || 'autor'}!<br><br>
      Seu livro <strong style="color:#C9A84C;">"${job.titulo || ''}"</strong> está em anexo neste e-mail.</p>
      <p style="font-size:12px;color:#888;margin-top:32px;">Lucel Digital · graficalucel@gmail.com · (11) 93496-4127</p>
    </div>`,
    attachments: [{ filename: job.nomeArquivo, content: job.docxBuffer }]
  });
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────
async function enviarWhatsapp(job, jobId) {
  if (!job.whatsapp) return;
  const num = job.whatsapp.replace(/\D/g, '');
  const msg = `🎉 *Olá, ${job.nome || 'autor'}!*\n\nSeu livro *"${job.titulo || 'YouTube → Livro'}"* ficou pronto!\n\n📎 O arquivo .docx foi enviado para o seu e-mail (${job.email}).\n\n_Lucel Digital_`;
  console.log('WhatsApp link:', `https://wa.me/${num}?text=${encodeURIComponent(msg)}`);
}

// ── AVISAR INÍCIO ─────────────────────────────────────────────────────────
async function avisarInicio(job, jobId) {
  if (!EMAIL_PASS || !job.email) return;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: job.email,
    subject: `🚀 Seu livro está sendo gerado — Lucel Digital`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#111;color:#F5F0E8;padding:40px;border-radius:12px;">
      <h1 style="color:#C9A84C;">Lucel Digital</h1>
      <h2>Confirmamos seu pagamento! 🚀</h2>
      <p>Olá, ${job.nome || 'autor'}!<br><br>
      Estamos gerando seu livro agora. Em breve você receberá o .docx <strong>direto no seu e-mail</strong>.</p>
      <p style="font-size:12px;color:#888;margin-top:32px;">Lucel Digital · graficalucel@gmail.com · (11) 93496-4127</p>
    </div>`
  });
}

// ── NOTIFICAR ADMIN ───────────────────────────────────────────────────────
async function notificarAdmin(jobId) {
  if (!EMAIL_PASS) return;
  const job = jobs[jobId];
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: EMAIL_USER,
    subject: `💰 Novo pedido — ${job.nome || job.email}`,
    html: `<div style="font-family:Arial,sans-serif;padding:32px;background:#111;color:#F5F0E8;border-radius:12px;">
      <h2 style="color:#C9A84C;">Novo pedido recebido!</h2>
      <p><b>Nome:</b> ${job.nome || '-'}<br>
      <b>Email:</b> ${job.email}<br>
      <b>WhatsApp:</b> ${job.whatsapp || '-'}<br>
      <b>Vídeo:</b> <a href="${job.youtubeUrl || '#'}" style="color:#C9A84C;">${job.youtubeUrl || 'N/A'}</a></p>
      <a href="${BASE_URL}/admin" style="display:inline-block;background:#C9A84C;color:#000;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;">Abrir Admin →</a>
    </div>`
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Lucel Digital rodando na porta ${PORT}`));
