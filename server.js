const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 10000;

// 1. CONFIGURAÇÃO DE DIRETÓRIOS
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// --- 2. ROTA DE API (O CORAÇÃO DO SISTEMA) ---
app.post('/api/processar', upload.single('audio'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ sucesso: false, erro: 'Arquivo MP3 não recebido.' });
    }

    // Responde JSON imediatamente para o navegador evitar o erro "Unexpected token <"
    res.status(200).json({ 
        sucesso: true, 
        mensagem: 'Upload realizado com sucesso! O livro está sendo gerado e será enviado por e-mail.' 
    });

    // Inicia o processamento pesado em segundo plano (Background)
    executarMotorIA(req.file.path, req.body.email || process.env.EMAIL_USER);
});

// --- 3. ROTAS DE INTERFACE (NAVEGAÇÃO) ---
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- 4. MOTOR DE INTELIGÊNCIA ARTIFICIAL (IA + ENVIO) ---
async function executarMotorIA(caminhoAudio, emailDestino) {
    try {
        console.log(`🎙️ Iniciando transcrição: ${caminhoAudio}`);

        // A. Upload para AssemblyAI
        const audioStream = fs.createReadStream(caminhoAudio);
        const upRes = await axios.post('https://api.assemblyai.com/v2/upload', audioStream, {
            headers: { 
                'authorization': process.env.ASSEMBLYAI_API_KEY, 
                'content-type': 'application/octet-stream' 
            }
        });

        // B. Solicitar Transcrição
        const transRes = await axios.post('https://api.assemblyai.com/v2/transcript', 
            { audio_url: upRes.data.upload_url, language_code: 'pt' },
            { headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY } }
        );

        // C. Aguardar Conclusão (Polling)
        let transcricao = '';
        while (true) {
            const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transRes.data.id}`, {
                headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
            });
            if (poll.data.status === 'completed') {
                transcricao = poll.data.text;
                break;
            }
            if (poll.data.status === 'error') throw new Error('Falha na transcrição da AssemblyAI');
            await new Promise(r => setTimeout(r, 5000));
        }

        console.log(`🤖 Gerando conteúdo com Claude 3.5 Sonnet...`);

        // D. Geração do Livro com Anthropic
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 4000,
            messages: [{ 
                role: "user", 
                content: `Atue como um editor profissional. Transforme esta transcrição em um capítulo de livro elegante e bem estruturado: ${transcricao}` 
            }]
        });
        const conteudoLivro = msg.content[0].text;

        // E. Configuração do E-mail (Nodemailer)
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { 
                user: process.env.EMAIL_USER, 
                pass: process.env.EMAIL_PASS // Senha de App de 16 dígitos
            }
        });

        await transporter.sendMail({
            from: `"Lucel Digital" <${process.env.EMAIL_USER}>`,
            to: emailDestino,
            subject: `Seu Livro está Pronto! - Lucel Digital`,
            text: conteudoLivro
        });

        console.log(`✅ Processo finalizado. E-mail enviado para: ${emailDestino}`);

        // Limpeza: Deleta o arquivo MP3 temporário do servidor
        if (fs.existsSync(caminhoAudio)) fs.unlinkSync(caminhoAudio);

    } catch (err) {
        console.error("❌ Erro no Motor IA:", err.message);
    }
}

// Inicialização do Servidor
app.listen(port, () => {
    console.log(`🚀 Lucel Digital rodando na porta ${port}`);
});
