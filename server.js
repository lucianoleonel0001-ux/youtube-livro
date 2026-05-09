const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const port = process.env.PORT || 10000;

// Configuração do Multer para salvar os áudios
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));

// Simulação de banco de dados (Substitua pela sua lógica de persistência se houver)
let jobs = {};

// Rota para receber o pedido com áudio
app.post('/api/upload-audio/:id', upload.single('audio'), async (req, res) => {
  const jobId = req.params.id;
  
  if (!req.file) {
    return res.status(400).send('Nenhum arquivo de áudio enviado.');
  }

  jobs[jobId] = {
    status: 'processando',
    progresso: 10,
    arquivo: req.file.path,
    mensagem: '📥 Áudio recebido. Iniciando transcrição...'
  };

  // Inicia o processo em segundo plano
  processarAudio(jobId, req.file.path);
  
  res.send({ message: 'Upload concluído!', jobId });
});

async function processarAudio(jobId, caminhoAudio) {
  try {
    // 1. Enviar para AssemblyAI
    jobs[jobId].progresso = 30;
    jobs[jobId].mensagem = '🎙️ Transcrevendo áudio...';
    
    const audioData = fs.readFileSync(caminhoAudio);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
      headers: { authorization: process.env.ASSEMBLYAI_API_KEY }
    });

    const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadRes.data.upload_url,
      language_code: 'pt'
    }, {
      headers: { authorization: process.env.ASSEMBLYAI_API_KEY }
    });

    // Loop de verificação da transcrição
    let transcript;
    while (true) {
      const pollingRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptRes.data.id}`, {
        headers: { authorization: process.env.ASSEMBLYAI_API_KEY }
      });
      if (pollingRes.data.status === 'completed') {
        transcript = pollingRes.data.text;
        break;
      } else if (pollingRes.data.status === 'error') {
        throw new Error('Falha na transcrição');
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    // 2. Enviar para o Claude (Anthropic)
    jobs[jobId].progresso = 70;
    jobs[jobId].mensagem = '🤖 Claude está escrevendo o livro...';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 4000,
      messages: [{ role: "user", content: `Transforme esta transcrição em um capítulo de livro estruturado: ${transcript}` }],
    });

    // 3. Finalização (Aqui você enviaria o e-mail)
    jobs[jobId].status = 'concluido';
    jobs[jobId].progresso = 100;
    jobs[jobId].mensagem = '✅ Livro gerado e pronto para envio!';
    
    // Limpeza opcional do arquivo
    // fs.unlinkSync(caminhoAudio);

  } catch (error) {
    console.error(error);
    jobs[jobId].status = 'erro';
    jobs[jobId].mensagem = '❌ Erro no processamento.';
  }
}

app.listen(port, () => console.log(`🚀 Servidor Lucel rodando na porta ${port}`));
