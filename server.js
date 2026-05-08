const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, PageBreak, TabStopPosition, TabStopType, Leader
} = require('docx');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
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

// ── CLIENTE: REGISTRAR PEDIDO ─────────────────────────────────────────────
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
  if (!job || !job.docxPath || !fs.existsSync(job.docxPath))
    return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(job.docxPath, job.nomeArquivo || 'livro.docx');
});

// ── ADMIN: LISTAR JOBS ────────────────────────────────────────────────────
app.get('/api/admin/jobs', adminAuth, (req, res) => res.json(jobs));

// ── ADMIN: CONFIRMAR PAGAMENTO ────────────────────────────────────────────
app.post('/api/admin/confirmar/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  job.status = 'pagamento_confirmado';
  job.mensagem = '✅ Pagamento confirmado. Aguardando transcrição...';
  await avisarInicio(job, req.params.jobId).catch(() => {});
  res.json({ ok: true });
});

// ── ADMIN: PROCESSAR TRANSCRIÇÃO COLADA ──────────────────────────────────
app.post('/api/admin/processar-texto/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  const { transcricao } = req.body;
  if (!transcricao || transcricao.length < 100) return res.status(400).json({ erro: 'Transcrição muito curta' });

  job.transcricao = transcricao;
  job.status = 'gerando';
  job.progresso = 50;
  job.mensagem = '🤖 Criando os 12 capítulos com IA...';
  res.json({ ok: true });

  processarComTranscricao(req.params.jobId).catch(err => {
    jobs[req.params.jobId].status = 'erro';
    jobs[req.params.jobId].mensagem = '❌ ' + err.message;
  });
});

// ── ADMIN: REENVIAR NOTIFICAÇÕES ──────────────────────────────────────────
app.post('/api/admin/reenviar/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  await Promise.allSettled([enviarEmail(job, req.params.jobId), enviarWhatsapp(job, req.params.jobId)]);
  res.json({ ok: true });
});

// ── ADMIN: EXCLUIR JOB ────────────────────────────────────────────────────
app.delete('/api/admin/excluir/:jobId', adminAuth, (req, res) => {
  delete jobs[req.params.jobId];
  res.json({ ok: true });
});

// ── PROCESSAR COM TRANSCRIÇÃO COLADA ─────────────────────────────────────
async function processarComTranscricao(jobId) {
  const job = jobs[jobId];
  const tmpDir = `/tmp/job_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    atualizar(jobId, 'gerando', 55, '🤖 Criando os 12 capítulos com IA...');
    const livro = await gerarLivro(job.transcricao, job.nome);

    atualizar(jobId, 'diagramando', 82, '📐 Diagramando o livro...');
    const docxPath = path.join(tmpDir, 'livro.docx');
    await gerarDocx(livro, docxPath);

    const nomeArquivo = livro.titulo.replace(/[^a-zA-Z0-9À-ú ]/g, '_').substring(0, 40) + '.docx';
    job.docxPath = docxPath;
    job.nomeArquivo = nomeArquivo;
    job.titulo = livro.titulo;

    atualizar(jobId, 'notificando', 93, '📲 Enviando notificações...');
    await Promise.allSettled([enviarEmail(job, jobId), enviarWhatsapp(job, jobId)]);

    atualizar(jobId, 'pronto', 100, '✅ Livro pronto para download!');

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
    model: 'claude-opus-4-5',
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

  children.push(
    new Paragraph({ children: [new TextRun({ text: livro.titulo.toUpperCase(), font: FONT_T, size: 80, bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 2000 } }),
    new Paragraph({ children: [new TextRun({ text: livro.subtitulo || '', font: FONT_C, size: 36, italics: true })], alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: '— —', font: FONT_C, size: 28 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: (livro.autor || 'Autor').toUpperCase(), font: FONT_T, size: 44 })], alignment: AlignmentType.CENTER, spacing: { before: 400 } }),
    new Paragraph({ children: [new PageBreak()] })
  );

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
      <p>Olá, ${job.nome || 'autor'}!<br><br>
      Seu livro <strong style="color:#C9A84C;">"${job.titulo || ''}"</strong> foi gerado e está disponível para download.</p>
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
  console.log('WhatsApp:', `https://wa.me/${num}?text=${encodeURIComponent(msg)}`);
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
      Estamos gerando seu livro agora. Em breve você receberá o .docx no seu e-mail e WhatsApp.</p>
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
      <b>Vídeo:</b> <a href="${job.youtubeUrl}" style="color:#C9A84C;">${job.youtubeUrl}</a></p>
      <a href="${BASE_URL}/admin" style="display:inline-block;background:#C9A84C;color:#000;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;">Abrir Admin →</a>
    </div>`
  });
}

// ── PÁGINAS ───────────────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Lucel Digital rodando na porta ${PORT}`));
