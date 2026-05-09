const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 10000;

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static(__dirname));

// Rota que o botão "Aprovar e Processar" chama
app.post('/api/processar', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ sucesso: false, erro: 'Arquivo não enviado.' });
    
    // Responde JSON para matar o erro "Unexpected token <"
    res.status(200).json({ sucesso: true, mensagem: 'Upload OK! Gerando livro...' });

    // Processamento em background (IA + Email)
    executarIA(req.file.path, process.env.EMAIL_USER);
});

app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

async function executarIA(caminho, email) {
    try {
        // Lógica de Transcrição e Claude (Seus códigos de IA aqui...)
        console.log("Processando arquivo:", caminho);
    } catch (err) { console.error(err); }
}

app.listen(port, () => console.log(`Rodando na porta ${port}`));
