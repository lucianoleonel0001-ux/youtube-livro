const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const path = require('path');
const multer = require('multer');
const ytDl = require('yt-dlp-exec');
const { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak } = require('docx');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configurações via Variáveis de Ambiente
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ASSEMBLY_KEY  = process.env.ASSEMBLYAI_API_KEY;
const EMAIL_USER    = process.env.EMAIL_USER || 'graficalucel@gmail.com';
const EMAIL_PASS    = process.env.EMAIL_PASS;
const ADMIN_KEY     = process.env.ADMIN_KEY  || 'lucel2026';
const COOKIES_PATH  = path.join(__dirname, 'cookies.txt');

const jobs = {};

// Middleware de Segurança
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ erro: 'Acesso negado' });
  next();
}

// Rota para o cliente solicitar o livro
app.post('/api/pedido', (req, res) => {
  const { youtubeUrl, nome, email, whatsapp } = req.body;
  if (!youtubeUrl || !email) return res.status(400).json({ erro: 'Dados incompletos' });
  
  const jobId = Date.now().toString();
  jobs[jobId] = {
    status: 'aguardando_pagamento',
    progresso: 0,
    mensagem: '⏳ Aguardando confirmação...',
    nome, email, whatsapp, youtubeUrl
  };
  res.json({ jobId });
});

// Rota para o Admin dar o "GO" no processo
app.post('/api/admin/processar/:jobId', adminAuth, async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) return res.status(404).json({ erro: 'Não encontrado' });

  iniciarFluxo(jobId).catch(err => {
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ Erro: ' + err.message;
  });

  res.json({ ok: true, mensagem: 'Automação iniciada' });
});

app.get('/api/status/:jobId', (req, res) => res.json(jobs[req.params.jobId] || {}));

// Função Mestra de Automação
async function iniciarFluxo(jobId) {
  const job = jobs[jobId];

  // 1. Download do áudio (Usa os cookies.txt)
  atualizar(jobId, 'baixando', 15, '📥 Extraindo áudio do YouTube...');
  const audioBuffer = await ytDl(job.youtubeUrl, {
    extractAudio: true, audioFormat: 'mp3', cookies: COOKIES_PATH, output: '-'
  }, { stdio: ['ignore', 'pipe', 'ignore'] });

  // 2. Transcrição (AssemblyAI)
  atualizar(jobId, 'transcrevendo', 40, '🎙️ Analisando fala...');
  const upload = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
    headers: { 'authorization': ASSEMBLY_KEY, 'content-type': 'application/octet-stream' }
  });

  const transcript = await axios.post('https://api.assemblyai.com/v2/transcript', 
    { audio_url: upload.data.upload_url, language_code: 'pt' },
    { headers: { 'authorization': ASSEMBLY_KEY } }
  );

  let textoFinal = '';
  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcript.data.id}`, {
      headers: { 'authorization': ASSEMBLY_KEY }
    });
    if (poll.data.status === 'completed') { textoFinal = poll.data.text; break; }
    if (poll.data.status === 'error') throw new Error('Falha na transcrição');
  }

  // 3. IA Escritora (Claude)
  atualizar(jobId, 'gerando', 75, '🤖 Claude está escrevendo os 12 capítulos...');
  const livro = await chamarClaude(textoFinal, job.nome);

  // 4. DOCX e E-mail
  atualizar(jobId, 'finalizando', 95, '✉️ Enviando livro para o e-mail...');
  const docx = await gerarDocx(livro);
  await enviarEmail(job, docx, livro.titulo);

  atualizar(jobId, 'pronto', 100, '✅ Processo concluído com sucesso!');
}

async function chamarClaude(transcricao, autor) {
  const prompt = `Transforme em um livro de 12 capítulos. Retorne APENAS JSON: {"titulo":"","subtitulo":"","capitulos":[{"numero":1,"titulo":"","texto":""}]}. Transcrição: ${transcricao.substring(0, 15000)}`;
  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-3-5-sonnet-20240620',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' } });
  return JSON.parse(resp.data.content[0].text);
}

async function gerarDocx(livro) {
  const sections = [{
    children: [
      new Paragraph({ text: livro.titulo, spacing: { before: 2000 }, alignment: AlignmentType.CENTER }),
      new Paragraph({ children: [new PageBreak()] }),
      ...livro.capitulos.map(c => [
        new Paragraph({ text: `Capítulo ${c.numero}: ${c.titulo}`, outlineLevel: 1 }),
        new Paragraph({ text: c.texto, alignment: AlignmentType.JUSTIFIED }),
        new Paragraph({ children: [new PageBreak()] })
      ]).flat()
    ]
  }];
  return await Packer.toBuffer(new Document({ sections }));
}

async function enviarEmail(job, buffer, titulo) {
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: EMAIL_USER, to: job.email,
    subject: `📚 Seu Livro: ${titulo}`,
    attachments: [{ filename: 'SeuLivro.docx', content: buffer }]
  });
}

function atualizar(id, status, prog, msg) { jobs[id] = { ...jobs[id], status, progresso: prog, mensagem: msg }; }

app.listen(process.env.PORT || 3000);
