FROM node:18-bullseye

# Instala FFmpeg e dependências de sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Cria pastas necessárias com permissões totais
RUN mkdir -p uploads && chmod 777 uploads

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000
CMD [ "node", "server.js" ]
