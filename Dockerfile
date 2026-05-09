FROM node:18-bullseye

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ESSA LINHA É A SOLUÇÃO DO SEU ÚLTIMO ERRO:
RUN ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD [ "node", "server.js" ]
