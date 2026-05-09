# Usa a imagem oficial do Node.js
FROM node:18-bullseye

# Instala Python e FFmpeg (Essenciais para o yt-dlp)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Cria a pasta do app
WORKDIR /usr/src/app

# Copia os arquivos de dependências
COPY package*.json ./

# Instala as dependências do Node
RUN npm install

# Copia o restante dos arquivos (incluindo cookies.txt e server.js)
COPY . .

# Expõe a porta 3000
EXPOSE 3000

# Comando para iniciar o servidor
CMD [ "node", "server.js" ]
