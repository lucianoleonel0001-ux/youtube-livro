const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 10000;

// 1. CONFIGURAÇÃO DE UPLOAD
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// 2. ROTAS DE INTERFACE
app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// 3. ROTA DE PROCESSAMENTO (O JavaScript do seu admin deve chamar ESTA URL)
app.post('/api/processar', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erro: 'Selecione um arquivo MP3.' });

        const emailCliente = req.body.email || process.env.EMAIL_USER;
        const jobId = Date.now().toString();

        // Inicia o processo em background
        executarIA(jobId, req.file.path, emailCliente);
        
        // RETORNA JSON (Para não dar o erro do Token <)
        res.status(200).json({ sucesso: true, mensagem: "Processamento iniciado!" });

    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// 4. MOTOR DE IA
async function executarIA(jobId, caminhoAudio, emailDestino) {
    try {
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
            if (poll.data.status === 'error') throw new Error('Erro na transcrição');
            await new Promise(r => setTimeout(r, 5000));
        }

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 4000,
            messages: [{ role: "user", content: `Transforme esta transcrição em um capítulo de livro profissional: ${transcricao}` }]
        });

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: emailDestino,
            subject: `Lucel Digital - Livro Pronto`,
            text: msg.content[0].text
        });

        if (fs.existsSync(caminhoAudio)) fs.unlinkSync(caminhoAudio);
    } catch (err) {
        console.error(`Erro:`, err.message);
    }
}

app.listen(port, () => console.log(`🚀 Lucel rodando na porta ${port}`));
