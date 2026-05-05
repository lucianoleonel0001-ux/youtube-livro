# Lucel Digital — YouTube → Livro

## Deploy no Render

### 1. Suba para o GitHub
```
git init
git add .
git commit -m "Lucel Digital YouTube para Livro"
git remote add origin https://github.com/lucianoleonel0001-ux/youtube-livro.git
git push -u origin main
```

### 2. Crie Web Service no Render
- Conecte o repositório `youtube-livro`
- Build Command: `npm install && pip install yt-dlp`
- Start Command: `node server.js`

### 3. Variáveis de Ambiente no Render
| Variável | Valor |
|---|---|
| `OPENAI_API_KEY` | sua chave sk-proj-... |
| `ANTHROPIC_API_KEY` | sua chave sk-ant-... |
| `EMAIL_USER` | graficalucel@gmail.com |
| `EMAIL_PASS` | senha de app do Gmail |
| `BASE_URL` | https://youtube-livro.onrender.com |

### 4. Instalar ffmpeg no Render
No Render, adicione um arquivo `render.yaml`:
```yaml
services:
  - type: web
    name: youtube-livro
    env: node
    buildCommand: apt-get install -y ffmpeg && npm install && pip install yt-dlp
    startCommand: node server.js
```
