# Servidor Marcos Motos na nuvem (Northflank ou Fly.io): API + site + agendador (posts agendados, apagar Stories, tokens).
# O render (Remotion/FFmpeg/Chrome) NÃO roda aqui: fica no motor do PC da loja, que conversa por HTTPS.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Só as 3 dependências do servidor, nas mesmas versões do package.json (sem Remotion/React, que são do motor e do site).
RUN npm init -y >/dev/null && npm pkg set type=module && npm install --omit=dev --no-audit --no-fund express@5.3.0 multer@2.5.0 @anthropic-ai/sdk@1.6.0
COPY server ./server
COPY shared ./shared
COPY brand-intelligence ./brand-intelligence
COPY dist ./dist
COPY deploy/entrypoint.sh /entrypoint.sh
ENV NODE_ENV=production TZ=America/Sao_Paulo BDX_DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["sh", "/entrypoint.sh"]
