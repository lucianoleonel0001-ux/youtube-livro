const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 10000;
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static(__dirname));

// Rota técnica para o botão do Admin
app.post('/api/processar', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ sucesso: false, erro: 'Arquivo vazio.' });
    
    // IMPORTANTE: Responde JSON para o navegador não dar erro de "Unexpected token <"
    res.status(200).json({ sucesso: true, mensagem: 'Upload OK! Iniciando processamento...' });
});

// Rotas para abrir seus arquivos HTML
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.listen(port, () => console.log(`🚀 Lucel ON na porta ${port}`));
