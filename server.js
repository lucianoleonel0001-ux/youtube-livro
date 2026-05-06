const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, PageBreak, TabStopPosition, TabStopType, Leader
} = require('docx');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const EMAIL_USER = process.env.EMAIL_USER || 'graficalucel@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const WHATS_NUM = process.env.WHATS_NUM || '5511934964127';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Guarda jobs em memória
const jobs = {};

// ── 1. INICIAR JOB ─────────────────────────────────────────────────────────
app.post('/api/processar', async (req, res) => {
  const { youtubeUrl, nome, email, whatsapp } = req.body;
  if (!youtubeUrl || !email) return res.status(400).json({ erro: 'URL e e-mail obrigatórios.' });

  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'iniciando', progresso: 0, nome, email, whatsapp, youtubeUrl };

  res.json({ jobId });

  // Processar em background
  processarVideo(jobId).catch(err => {
    console.error('Erro no job', jobId, err);
    jobs[jobId].status = 'erro';
    jobs[jobId].erro = err.message;
  });
});

// ── 2. STATUS DO JOB ───────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Job não encontrado' });
  res.json(job);
});

// ── 3. DOWNLOAD DO DOCX ────────────────────────────────────────────────────
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.docxPath) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(job.docxPath, job.nomeArquivo || 'livro.docx');
});

// ── PROCESSAMENTO PRINCIPAL ────────────────────────────────────────────────
async function processarVideo(jobId) {
  const job = jobs[jobId];
  const tmpDir = `/tmp/job_${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // ETAPA 1 — Baixar áudio
    atualizarJob(jobId, 'baixando', 10, '⏬ Baixando áudio do YouTube...');
    const audioPath = path.join(tmpDir, 'audio.mp3');
    const audioTemplate = path.join(tmpDir, 'audio.%(ext)s');
    await execAsync(`yt-dlp -x --audio-format mp3 --audio-quality 0 -o '${audioTemplate}' '${job.youtubeUrl}' 2>&1`);
    // yt-dlp pode nomear diferente, encontrar o mp3
    const files = fs.readdirSync(tmpDir);
    const audioFile = files.find(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.webm') || f.endsWith('.opus'));
    if (!audioFile) throw new Error('Não foi possível baixar o áudio do vídeo.');
    const audioFinal = path.join(tmpDir, audioFile);

    // Verificar tamanho (Whisper aceita até 25MB)
    const stats = fs.statSync(audioFinal);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > 24) {
      // Cortar para 24MB se necessário
      atualizarJob(jobId, 'baixando', 15, '✂️ Otimizando áudio...');
      const audioCorte = path.join(tmpDir, 'audio_corte.mp3');
      await execAsync(`ffmpeg -i "${audioFinal}" -fs 24000000 -acodec libmp3lame "${audioCorte}" -y`);
    }

    const audioEnviar = fs.existsSync(path.join(tmpDir, 'audio_corte.mp3'))
      ? path.join(tmpDir, 'audio_corte.mp3')
      : audioFinal;

    // ETAPA 2 — Transcrever
    atualizarJob(jobId, 'transcrevendo', 30, '🎙️ Transcrevendo o áudio...');
    const transcricao = await transcreverAudio(audioEnviar);
    if (!transcricao || transcricao.length < 100) throw new Error('Transcrição muito curta ou falhou.');

    // ETAPA 3 — Gerar livro com IA
    atualizarJob(jobId, 'gerando', 55, '🤖 Criando os 12 capítulos com IA...');
    const livro = await gerarLivro(transcricao, job.nome);

    // ETAPA 4 — Diagramar
    atualizarJob(jobId, 'diagramando', 80, '📐 Diagramando o livro...');
    const docxPath = path.join(tmpDir, 'livro.docx');
    await gerarDocx(livro, docxPath);

    // ETAPA 5 — Notificações
    atualizarJob(jobId, 'notificando', 92, '📲 Enviando notificações...');
    const nomeArquivo = `${livro.titulo.replace(/[^a-zA-Z0-9À-ú ]/g, '_').substring(0, 40)}.docx`;
    job.docxPath = docxPath;
    job.nomeArquivo = nomeArquivo;
    job.titulo = livro.titulo;

    await Promise.allSettled([
      enviarEmail(job),
      enviarWhatsapp(job)
    ]);

    atualizarJob(jobId, 'pronto', 100, '✅ Livro pronto para download!');

  } catch (err) {
    console.error(err);
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ Erro: ' + err.message;
    throw err;
  } finally {
    // Limpar arquivos temporários depois de 1h
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
      delete jobs[jobId];
    }, 3600000);
  }
}

function atualizarJob(jobId, status, progresso, mensagem) {
  jobs[jobId] = { ...jobs[jobId], status, progresso, mensagem };
  console.log(`[${jobId}] ${mensagem}`);
}

// ── TRANSCREVER COM WHISPER ────────────────────────────────────────────────
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

// ── GERAR LIVRO COM CLAUDE ─────────────────────────────────────────────────
async function gerarLivro(transcricao, nomeAutor) {
  const prompt = `Você é um escritor e editor profissional brasileiro.

Com base na transcrição abaixo de um vídeo do YouTube, crie um livro completo em português com exatamente 12 capítulos.

INSTRUÇÕES:
- Melhore a linguagem falada para linguagem escrita literária e fluente
- Corrija erros gramaticais e ortográficos
- Organize o conteúdo em 12 capítulos coesos com títulos criativos
- Cada capítulo deve ter pelo menos 3 parágrafos ricos e completos
- Crie uma introdução e uma conclusão dentro dos 12 capítulos
- Mantenha a essência e as ideias principais do autor

Responda APENAS em JSON válido, sem texto antes ou depois, neste formato:
{
  "titulo": "Título criativo do livro",
  "subtitulo": "Subtítulo complementar",
  "autor": "${nomeAutor || 'Autor'}",
  "capitulos": [
    {
      "numero": 1,
      "titulo": "Título do Capítulo",
      "texto": "Texto completo do capítulo com vários parágrafos separados por \\n\\n"
    }
  ]
}

TRANSCRIÇÃO:
${transcricao.substring(0, 12000)}`;

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 120000
  });

  const texto = resp.data.content[0].text;
  const jsonMatch = texto.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('IA não retornou JSON válido');
  return JSON.parse(jsonMatch[0]);
}

// ── GERAR DOCX ────────────────────────────────────────────────────────────
async function gerarDocx(livro, outputPath) {
  const FONT_TITULO = 'Bebas Neue';
  const FONT_CORPO  = 'Palatino Linotype';

  const children = [];

  // Página de rosto
  children.push(
    new Paragraph({ children: [new TextRun({ text: livro.titulo.toUpperCase(), font: FONT_TITULO, size: 80, bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 2000 } }),
    new Paragraph({ children: [new TextRun({ text: livro.subtitulo || '', font: FONT_CORPO, size: 36, italics: true })], alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: '— —', font: FONT_CORPO, size: 28 })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: (livro.autor || 'Autor').toUpperCase(), font: FONT_TITULO, size: 44 })], alignment: AlignmentType.CENTER, spacing: { before: 400 } }),
    new Paragraph({ children: [new PageBreak()] })
  );

  // Sumário
  children.push(
    new Paragraph({ children: [new TextRun({ text: 'SUMÁRIO', font: FONT_TITULO, size: 48 })], alignment: AlignmentType.CENTER, spacing: { before: 400, after: 400 } })
  );
  (livro.capitulos || []).forEach(cap => {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: `${cap.numero}. ${cap.titulo}`, font: FONT_CORPO, size: 24 }),
        new TextRun({ text: '\t', font: FONT_CORPO, size: 24 }),
        new TextRun({ text: `${cap.numero + 1}`, font: FONT_CORPO, size: 24 })
      ],
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: Leader.DOT }],
      spacing: { before: 80, after: 60 }
    }));
  });
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Capítulos
  (livro.capitulos || []).forEach(cap => {
    children.push(
      new Paragraph({ children: [new TextRun({ text: `CAPÍTULO ${cap.numero}`, font: FONT_TITULO, size: 28, color: '888888' })], spacing: { before: 400, after: 100 } }),
      new Paragraph({ children: [new TextRun({ text: cap.titulo.toUpperCase(), font: FONT_TITULO, size: 48 })], spacing: { before: 0, after: 400 } })
    );

    const paragrafos = (cap.texto || '').split('\n\n').filter(p => p.trim());
    paragrafos.forEach(p => {
      children.push(new Paragraph({
        children: [new TextRun({ text: p.trim(), font: FONT_CORPO, size: 24 })],
        alignment: AlignmentType.JUSTIFIED,
        indent: { firstLine: 720 },
        spacing: { line: 276, after: 0 }
      }));
    });

    children.push(new Paragraph({ children: [new PageBreak()] }));
  });

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 7938, height: 11906 }, // 14x21cm
          margin: { top: 992, bottom: 992, left: 1134, right: 1134 }
        }
      },
      children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ── EMAIL ─────────────────────────────────────────────────────────────────
async function enviarEmail(job) {
  if (!EMAIL_PASS || !job.email) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
  await transporter.sendMail({
    from: `Lucel Digital <${EMAIL_USER}>`,
    to: job.email,
    subject: `📚 Seu livro "${job.titulo}" está pronto!`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#111;color:#F5F0E8;padding:40px;border-radius:12px;">
        <h1 style="color:#C9A84C;font-size:32px;margin-bottom:8px;">Lucel Digital</h1>
        <h2 style="font-size:22px;margin-bottom:24px;">Seu livro está pronto! 🎉</h2>
        <p style="font-size:16px;line-height:1.7;margin-bottom:24px;">
          Olá, ${job.nome || 'autor'}!<br><br>
          Seu vídeo do YouTube foi transformado no livro <strong style="color:#C9A84C;">"${job.titulo}"</strong> e já está disponível para download.
        </p>
        <a href="${BASE_URL}/api/download/${Object.keys(jobs).find(k => jobs[k] === job)}"
           style="display:inline-block;background:#C9A84C;color:#000;font-weight:bold;padding:16px 40px;border-radius:6px;text-decoration:none;font-size:16px;">
          📥 Baixar meu livro (.docx)
        </a>
        <p style="font-size:13px;color:#888;margin-top:32px;">
          Lucel Digital · graficalucel@gmail.com · (11) 93496-4127
        </p>
      </div>
    `
  });
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────
async function enviarWhatsapp(job) {
  if (!job.whatsapp) return;
  const num = job.whatsapp.replace(/\D/g, '');
  const jobId = Object.keys(jobs).find(k => jobs[k] === job);
  const msg = `🎉 *Olá, ${job.nome || 'autor'}!*\n\nSeu livro *"${job.titulo}"* ficou pronto!\n\n📥 Baixe agora:\n${BASE_URL}/api/download/${jobId}\n\n_Lucel Digital_`;
  const link = `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
  console.log('WhatsApp link:', link);
  // Em produção integrar com Z-API ou Evolution API
}

// ── ROTAS ADMIN ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== (process.env.ADMIN_KEY || 'lucel2026')) return res.status(401).json({ erro: 'Não autorizado' });
  next();
}

app.get('/api/admin/jobs', adminAuth, (req, res) => res.json(jobs));

app.post('/api/admin/reenviar/:jobId', adminAuth, async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Job não encontrado' });
  await Promise.allSettled([enviarEmail(job), enviarWhatsapp(job)]);
  res.json({ ok: true });
});

app.delete('/api/admin/excluir/:jobId', adminAuth, (req, res) => {
  delete jobs[req.params.jobId];
  res.json({ ok: true });
});


app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Lucel Digital rodando na porta ${PORT}`));
