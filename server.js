const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 10000;

// Configuração de pastas
const dir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ROTAS DE INTERFACE
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ROTA DE API (Onde o erro ocorria)
app.post('/api/processar', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ sucesso: false, erro: 'Selecione um arquivo MP3.' });
        }

        const emailCliente = req.body.email || process.env.EMAIL_USER;
        
        // Dispara o processamento sem travar a tela do admin
        executarIA(req.file.path, emailCliente);
        
        // RESPOSTA SEMPRE EM JSON
        return res.status(200).json({ 
            sucesso: true, 
            mensagem: 'Upload realizado! O livro será enviado para o e-mail em instantes.' 
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ sucesso: false, erro: 'Erro interno no servidor.' });
    }
});

async function executarIA(caminhoAudio, emailDestino) {
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
            if (poll.data.status === 'error') throw new Error('Erro transcrição');
            await new Promise(r => setTimeout(r, 5000));
        }

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 4000,
            messages: [{ role: "user", content: `Escreva um capítulo de livro baseado nesta transcrição: ${transcricao}` }]
        });

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

        fs.unlinkSync(caminhoAudio);
    } catch (err) {
        console.error("Erro no processamento:", err.message);
    }
}

app.listen(port, () => console.log(`🚀 Lucel rodando na porta ${port}`));
