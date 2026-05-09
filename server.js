const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const path = require('path');
const multer = require('multer');
const ytDl = require('yt-dlp-exec');
const { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak } = require('docx');

const app = express();

// Configurações de limite para suportar grandes volumes de dados
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middleware para servir arquivos estáticos (CSS, JS, Imagens)
app.use(express.static(__dirname));

// CONFIGURAÇÕES DE AMBIENTE (Certifique-se de preencher no Render)
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ASSEMBLY_KEY  = process.env.ASSEMBLYAI_API_KEY;
const EMAIL_USER    = process.env.EMAIL_USER || 'graficalucel@gmail.com';
const EMAIL_PASS    = process.env.EMAIL_PASS;
const ADMIN_KEY     = process.env.ADMIN_KEY  || 'lucel2026';
const COOKIES_PATH  = path.join(__dirname, 'cookies.txt');

// Objeto em memória para armazenar os pedidos (jobs)
const jobs = {};

// Middleware de Autenticação para Admin
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ erro: 'Acesso negado' });
  next();
}

// ── ROTAS DE NAVEGAÇÃO ───────────────────────────────────────────────────

// Página Inicial (Landing Page)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

// Página do App (Onde o cliente faz o pedido)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Painel Administrativo
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── ROTAS DA API ─────────────────────────────────────────────────────────

// Cliente registra o pedido
app.post('/api/pedido', (req, res) => {
  const { youtubeUrl, nome, email, whatsapp } = req.body;
  if (!youtubeUrl || !email) return res.status(400).json({ erro: 'URL e E-mail são obrigatórios.' });
  
  const jobId = Date.now().toString();
  jobs[jobId] = {
    status: 'aguardando_pagamento',
    progresso: 0,
    mensagem: '⏳ Aguardando confirmação do pagamento...',
    nome, email, whatsapp, youtubeUrl,
    criadoEm: new Date().toISOString()
  };
  res.json({ jobId });
});

// Consultar status do pedido
app.get('/api/status/:jobId', (req, res) => {
  res.json(jobs[req.params.jobId] || { erro: 'Não encontrado' });
});

// Listar todos os pedidos (Apenas Admin)
app.get('/api/admin/jobs', adminAuth, (req, res) => {
  res.json(jobs);
});

// Iniciar Processamento (Gatilho do Admin)
app.post('/api/admin/processar/:jobId', adminAuth, async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) return res.status(404).json({ erro: 'Job não encontrado' });

  // Inicia o fluxo em background
  fluxoAutomacao(jobId).catch(err => {
    console.error("Erro Crítico:", err);
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ Erro: ' + err.message;
  });

  res.json({ ok: true, mensagem: 'Processamento iniciado' });
});

// ── MOTOR DE AUTOMAÇÃO (LOGICA PRINCIPAL) ────────────────────────────────

async function fluxoAutomacao(jobId) {
  const job = jobs[jobId];

  try {
    // 1. Download do áudio via yt-dlp usando os cookies
    atualizar(jobId, 'baixando', 10, '📥 Baixando áudio do YouTube...');
    const audioBuffer = await ytDl(job.youtubeUrl, {
      extractAudio: true,
      audioFormat: 'mp3',
      cookies: COOKIES_PATH,
      output: '-',
    }, { stdio: ['ignore', 'pipe', 'ignore'] });

    // 2. Upload para AssemblyAI
    atualizar(jobId, 'transcrevendo', 30, '⏫ Enviando para análise...');
    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
      headers: { 'authorization': ASSEMBLY_KEY, 'content-type': 'application/octet-stream' }
    });

    // 3. Iniciar Transcrição
    const transcriptReq = await axios.post('https://api.assemblyai.com/v2/transcript', 
      { audio_url: uploadResp.data.upload_url, language_code: 'pt' },
      { headers: { 'authorization': ASSEMBLY_KEY } }
    );

    // 4. Aguardar Transcrição (Polling)
    let textoTranscrito = '';
    while (true) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptReq.data.id}`, {
        headers: { 'authorization': ASSEMBLY_KEY }
      });
      if (poll.data.status === 'completed') { textoTranscrito = poll.data.text; break; }
      if (poll.data.status === 'error') throw new Error('Falha na transcrição');
    }

    // 5. Claude 3.5 Sonnet: Escrita Literária
    atualizar(jobId, 'gerando', 70, '🤖 Claude está transformando o vídeo em livro...');
    const livro = await gerarLivroComIA(textoTranscrito, job.nome);

    // 6. Diagramação DOCX
    atualizar(jobId, 'diagramando', 90, '📐 Criando arquivo 14x21cm...');
    const docxBuffer = await criarArquivoDocx(livro);
    
    // 7. Envio por E-mail
    await enviarEmailComAnexo(job, docxBuffer, livro.titulo);

    atualizar(jobId, 'pronto', 100, '✅ Livro enviado para o e-mail do cliente!');

  } catch (error) {
    throw error;
  }
}

// INTEGRAÇÃO CLAUDE
async function gerarLivroComIA(transcricao, autor) {
  const prompt = `Aja como um Ghostwriter profissional. Crie um livro de exatamente 12 capítulos baseado na transcrição abaixo. 
  Mantenha o tom literário e fluido. Responda APENAS com o JSON no formato:
  {"titulo":"...","subtitulo":"...","autor":"${autor}","capitulos":[{"numero":1,"titulo":"...","texto":"..."}]}
  
  Transcrição: ${transcricao.substring(0, 15000)}`;

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-3-5-sonnet-20240620',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
  });

  return JSON.parse(resp.data.content[0].text);
}

// DIAGRAMAÇÃO DOCX
async function criarArquivoDocx(livro) {
  const children = [
    new Paragraph({ 
      children: [new TextRun({ text: livro.titulo.toUpperCase(), font: 'Bebas Neue', size: 72, bold: true })], 
      alignment: AlignmentType.CENTER, spacing: { before: 2000 } 
    }),
    new Paragraph({ children: [new PageBreak()] })
  ];

  livro.capitulos.forEach(cap => {
    children.push(new Paragraph({ 
      children: [new TextRun({ text: `Capítulo ${cap.numero}: ${cap.titulo}`, font: 'Bebas Neue', size: 36 })], 
      spacing: { before: 400, after: 200 } 
    }));
    children.push(new Paragraph({ 
      children: [new TextRun({ text: cap.texto, font: 'Palatino Linotype', size: 24 })], 
      alignment: AlignmentType.JUSTIFIED,
      spacing: { line: 360 }
    }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  });

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 7938, height: 11906 } } }, // Aprox 14x21cm
      children: children
    }]
  });

  return await Packer.toBuffer(doc);
}

// ENVIO DE E-MAIL
async function enviarEmailComAnexo(job, buffer, titulo) {
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: job.email,
    subject: `📚 Seu Livro: ${titulo}`,
    html: `<h1>Parabéns!</h1><p>Seu livro gerado do YouTube está pronto e em anexo.</p>`,
    attachments: [{ filename: `${titulo}.docx`, content: buffer }]
  });
}

function atualizar(id, status, prog, msg) {
  jobs[id] = { ...jobs[id], status, progresso: prog, mensagem: msg };
  console.log(`[${id}] ${msg}`);
}

// INICIALIZAÇÃO
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Lucel Digital rodando na porta ${PORT}`));
