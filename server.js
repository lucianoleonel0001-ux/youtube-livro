const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 10000;

// Garante que a pasta uploads exista
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// --- ROTAS DE INTERFACE ---
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// --- ROTA DE API (Ajustada para o seu fetch) ---
app.post('/api/processar', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ sucesso: false, erro: 'Selecione um arquivo MP3.' });
        }

        // Responde IMEDIATAMENTE para o navegador não travar e não dar erro de JSON
        res.status(200).json({ 
            sucesso: true, 
            mensagem: 'Upload realizado com sucesso! O processamento começou.' 
        });

        // Executa a parte pesada em background
        const emailCliente = req.body.email || process.env.EMAIL_USER;
        executarIA(req.file.path, emailCliente);

    } catch (err) {
        console.error("Erro na rota:", err);
        if (!res.headersSent) {
            res.status(500).json({ sucesso: false, erro: 'Erro no servidor.' });
        }
    }
});

async function executarIA(caminhoAudio, emailDestino) {
    try {
        // 1. AssemblyAI (Transcrição)
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
            if (poll.data.status === 'error') throw new Error('Falha na transcrição');
            await new Promise(r => setTimeout(r, 5000));
        }

        // 2. Claude (Escrita)
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 4000,
            messages: [{ role: "user", content: `Escreva um capítulo de livro baseado nesta transcrição: ${transcricao}` }]
        });

        // 3. Nodemailer (Envio)
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: emailDestino,
            subject: `Lucel Digital - Livro Gerado`,
            text: msg.content[0].text
        });

        if (fs.existsSync(caminhoAudio)) fs.unlinkSync(caminhoAudio);
        console.log("✅ Processo concluído e e-mail enviado.");

    } catch (err) {
        console.error("❌ Erro no motor de IA:", err.message);
    }
}

app.listen(port, () => console.log(`🚀 Servidor Lucel rodando na porta ${port}`));
