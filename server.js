const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 10000;

// Configuração de Armazenamento
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());

// Banco de dados temporário para o progresso
let jobs = {};

// Rota Principal de Upload (Para seu Painel Admin)
app.post('/api/processar/:id', upload.single('audio'), async (req, res) => {
    const jobId = req.params.id;
    if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo MP3.' });

    jobs[jobId] = { status: 'iniciado', progresso: 10, mensagem: 'Arquivo recebido.' };
    
    // Executa o fluxo pesado em background
    executarFluxoIA(jobId, req.file.path, req.body.emailCliente);
    
    res.json({ sucesso: true, jobId });
});

async function executarFluxoIA(jobId, caminhoAudio, emailDestino) {
    try {
        // 1. Transcrição (AssemblyAI)
        jobs[jobId].progresso = 30;
        const audioStream = fs.createReadStream(caminhoAudio);
        const upRes = await axios.post('https://api.assemblyai.com/v2/upload', audioStream, {
            headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' }
        });

        const transRes = await axios.post('https://api.assemblyai.com/v2/transcript', 
            { audio_url: upRes.data.upload_url, language_code: 'pt' },
            { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY } }
        );

        let transcricao = '';
        while (true) {
            const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transRes.data.id}`, {
                headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
            });
            if (poll.data.status === 'completed') { transcricao = poll.data.text; break; }
            if (poll.data.status === 'error') throw new Error('Falha AssemblyAI');
            await new Promise(r => setTimeout(r, 5000));
        }

        // 2. Escrita do Livro (Claude 3.5 Sonnet)
        jobs[jobId].progresso = 70;
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 4000,
            messages: [{ role: "user", content: `Escreva um capítulo de livro profissional e estruturado a partir desta transcrição: ${transcricao}` }]
        });
        const conteudoLivro = msg.content[0].text;

        // 3. Envio por E-mail (Nodemailer)
        jobs[jobId].progresso = 90;
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: emailDestino,
            subject: 'Seu Livro Gerado - Lucel Digital',
            text: conteudoLivro
        });

        jobs[jobId].status = 'concluido';
        jobs[jobId].progresso = 100;
        fs.unlinkSync(caminhoAudio); // Deleta o áudio para economizar espaço

    } catch (err) {
        jobs[jobId].status = 'erro';
        jobs[jobId].mensagem = err.message;
    }
}

app.listen(port, () => console.log(`🚀 Lucel Digital Live na porta ${port}`));
