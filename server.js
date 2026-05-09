const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, PageBreak, TabStopPosition, TabStopType, Leader
} = require('docx');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY    = process.env.OPENAI_API_KEY || '';
const EMAIL_USER    = process.env.EMAIL_USER || 'graficalucel@gmail.com';
const EMAIL_PASS    = process.env.EMAIL_PASS || '';
const BASE_URL      = process.env.BASE_URL   || 'https://youtube-livro-1.onrender.com';
const ADMIN_KEY     = process.env.ADMIN_KEY  || 'lucel2026';

// Persistência
const JOBS_FILE = '/tmp/jobs.json';

function carregarJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function salvarJobs() {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs), 'utf8');
  } catch(e) {}
}

const jobs = carregarJobs();
const docxBuffers = {};

// AUTH
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ erro: 'Não autorizado' });
  next();
}

// PÁGINAS
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// REGISTRAR PEDIDO
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
  salvarJobs();
  notificarAdmin(jobId).catch(() => {});
  res.json({ jobId });
});

// STATUS
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  res.json(job);
});

// DOWNLOAD
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  const buf = docxBuffers[req.params.jobId];
  if (!job || !buf) return res.status(404).send('Arquivo não encontrado.');
  res.setHeader('Content-Disposition', `attachment; filename="${job.nomeArquivo || 'livro.docx'}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.send(buf);
});

// ADMIN: LISTAR
app.get('/api/admin/jobs', adminAuth, (req, res) => res.json(jobs));

// ADMIN: CONFIRMAR PAGAMENTO
app.post('/api/admin/confirmar/:jobId', adminAuth, async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  job.status = 'pagamento_confirmado';
  job.mensagem = '✅ Pagamento confirmado. Seu livro será processado em breve!';
  salvarJobs();

  const linkAcompanhamento = `${BASE_URL}/app?job=${jobId}`;
  enviarEmailConfirmacao(job, linkAcompanhamento).catch(() => {});
  enviarWhatsappConfirmacao(job, linkAcompanhamento).catch(() => {});

  res.json({ ok: true });
});

// ADMIN: UPLOAD MP3
app.post('/api/admin/upload/:jobId', adminAuth, upload.single('audio'), async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });

  job.status = 'transcrevendo';
  job.progresso = 20;
  job.mensagem = '⏫ Enviando áudio para transcrição...';
  salvarJobs();

  const audioBuffer = req.file.buffer;
  const audioMimetype = req.file.mimetype || 'audio/mpeg';
  const audioOriginalname = req.file.originalname || 'audio.mp3';

  res.json({ ok: true });

  processarComAudioBuffer(jobId, audioBuffer, audioMimetype, audioOriginalname).catch(err => {
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ ' + err.message;
    salvarJobs();
    console.error(`[${jobId}] Erro:`, err.message);
  });
});

// ADMIN: REENVIAR
app.post('/api/admin/reenviar/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Não encontrado' });
  await Promise.allSettled([enviarEmailFinal(job, req.params.jobId), enviarWhatsappFinal(job, req.params.jobId)]);
  res.json({ ok: true });
});

// ADMIN: EXCLUIR
app.delete('/api/admin/excluir/:jobId', adminAuth, (req, res) => {
  delete jobs[req.params.jobId];
  delete docxBuffers[req.params.jobId];
  salvarJobs();
  res.json({ ok: true });
});

// PROCESSAR COM WHISPER
async function processarComAudioBuffer(jobId, audioBuffer, mimetype, originalname) {
  const job = jobs[jobId];
  try {
    atualizar(jobId, 'transcrevendo', 30, '🎙️ Transcrevendo o áudio com Whisper...');

    // Salva buffer temporariamente para enviar ao Whisper
    const tmpFile = `/tmp/audio_${jobId}.mp3`;
    fs.writeFileSync(tmpFile, audioBuffer);

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpFile), {
      filename: originalname,
      contentType: mimetype
    });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');

    const whisperResp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      maxBodyLength: Infinity,
      timeout: 600000
    });

    // Remove arquivo temporário
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

    const transcricao = whisperResp.data.text;
    if (!transcricao || transcricao.length < 50) throw new Error('Transcrição retornou vazia');

    console.log(`[${jobId}] Transcrição concluída: ${transcricao.length} caracteres`);

    atualizar(jobId, 'gerando', 60, '🤖 Criando os 12 capítulos com IA...');
    const livro = await gerarLivro(transcricao, job.nome);

    atualizar(jobId, 'diagramando', 82, '📐 Diagramando o livro...');
    const docxBuffer = await gerarDocxBuffer(livro);

    const nomeArquivo = (livro.titulo || 'livro').replace(/[^a-zA-Z0-9À-ú ]/g, '_').substring(0, 40) + '.docx';
    docxBuffers[jobId] = docxBuffer;
    job.nomeArquivo = nomeArquivo;
    job.titulo = livro.titulo;

    atualizar(jobId, 'notificando', 93, '📲 Enviando livro por e-mail...');
    await Promise.allSettled([enviarEmailFinal(job, jobId, docxBuffer), enviarWhatsappFinal(job, jobId)]);

    atualizar(jobId, 'pronto', 100, '✅ Livro pronto! Faça o download abaixo.');

  } catch(err) {
    // Remove arquivo temporário em caso de erro
    const tmpFile = `/tmp/audio_${jobId}.mp3`;
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ ' + err.message;
    salvarJobs();
    console.error(`[${jobId}] Erro:`, err.message);
  }
}

function atualizar(jobId, status, progresso, mensagem) {
  jobs[jobId] = { ...jobs[jobId], status, progresso, mensagem };
  salvarJobs();
  console.log(`[${jobId}] ${mensagem}`);
}

// CLAUDE
async function gerarLivro(transcricao, nomeAutor) {
  const prompt = `Você é um escritor e editor profissional brasileiro. Com base na transcrição abaixo, crie um livro completo em português com exatamente 12 capítulos. Melhore a linguagem falada para escrita literária fluente. Cada capítulo deve ter pelo menos 3 parágrafos completos. Responda APENAS em JSON válido sem texto extra:

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

// DOCX
async function gerarDocxBuffer(livro) {
  const FONT_T = 'Bebas Neue';
  const FONT_C = 'Palatino Linotype';
  const children = [];

  children.push(
    new Paragraph({ children: [new TextRun({ text: (livro.titulo || '').toUpperCase(), font: FONT_T, size: 80, bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 2000 } }),
    new Paragraph({ children: [new TextRun({ text: livro.subtitulo || '', font: FONT_C, size: 36, italics: true })], alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } }),
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

// EMAILS
async function enviarEmailConfirmacao(job, linkAcompanhamento) {
  if (!EMAIL_PASS || !job.email) return;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: job.email,
    subject: `🚀 Seu pagamento foi confirmado — Lucel Digital`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#111;color:#F5F0E8;padding:40px;border-radius:12px;">
      <h1 style="color:#C9A84C;">Lucel Digital</h1>
      <h2>Pagamento confirmado! 🚀</h2>
      <p>Olá, ${job.nome || 'autor'}!<br><br>
      Seu pagamento foi confirmado. Estamos processando seu livro agora.<br><br>
      Acompanhe o progresso em tempo real:</p>
      <a href="${linkAcompanhamento}" style="display:inline-block;background:#C9A84C;color:#000;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;margin-top:16px;">📱 Acompanhar meu livro →</a>
      <p style="font-size:12px;color:#888;margin-top:32px;">Lucel Digital · graficalucel@gmail.com · (11) 93496-4127</p>
    </div>`
  });
}

async function enviarWhatsappConfirmacao(job, linkAcompanhamento) {
  if (!job.whatsapp) return;
  const num = job.whatsapp.replace(/\D/g, '');
  const msg = `✅ *Olá, ${job.nome || 'autor'}!*\n\nSeu pagamento foi confirmado! Estamos processando seu livro.\n\n📱 Acompanhe o progresso aqui:\n${linkAcompanhamento}\n\n_Lucel Digital_`;
  console.log('WhatsApp confirmação:', `https://wa.me/${num}?text=${encodeURIComponent(msg)}`);
}

async function enviarEmailFinal(job, jobId, docxBuffer) {
  if (!EMAIL_PASS || !job.email) return;
  const buf = docxBuffer || docxBuffers[jobId];
  if (!buf) return;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: job.email,
    subject: `📚 Seu livro "${job.titulo || 'YouTube → Livro'}" está pronto!`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#111;color:#F5F0E8;padding:40px;border-radius:12px;">
      <h1 style="color:#C9A84C;">Lucel Digital</h1>
      <h2>Seu livro está pronto! 🎉</h2>
      <p>Olá, ${job.nome || 'autor'}!<br><br>
      Seu livro <strong style="color:#C9A84C;">"${job.titulo || ''}"</strong> está em anexo.</p>
      <p style="font-size:12px;color:#888;margin-top:32px;">Lucel Digital · graficalucel@gmail.com · (11) 93496-4127</p>
    </div>`,
    attachments: [{ filename: job.nomeArquivo || 'livro.docx', content: buf }]
  });
}

async function enviarWhatsappFinal(job, jobId) {
  if (!job.whatsapp) return;
  const num = job.whatsapp.replace(/\D/g, '');
  const msg = `🎉 *Olá, ${job.nome || 'autor'}!*\n\nSeu livro *"${job.titulo || 'YouTube → Livro'}"* ficou pronto!\n\n📎 O arquivo .docx foi enviado para o seu e-mail (${job.email}).\n\n_Lucel Digital_`;
  console.log('WhatsApp final:', `https://wa.me/${num}?text=${encodeURIComponent(msg)}`);
}

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
      <b>Vídeo:</b> ${job.youtubeUrl || 'N/A'}</p>
      <a href="${BASE_URL}/admin" style="display:inline-block;background:#C9A84C;color:#000;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;">Abrir Admin →</a>
    </div>`
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Lucel Digital rodando na porta ${PORT}`));
